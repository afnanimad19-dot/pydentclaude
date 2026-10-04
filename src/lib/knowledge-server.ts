import type { NextRequest } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { authorizeRequest, serviceRoleConfigured } from "@/lib/server-auth-deps";
import { extractDocument } from "@/lib/kb-extract";
import { defaultWebsiteDeps, engineFetchForWorkspace, importWebsite } from "@/lib/kb-website";
import {
  KnowledgeMigrationMissing,
  type AssignmentRow,
  type ChangeResult,
  type DocumentChange,
  type DocumentRow,
  type KnowledgeStore,
  type ResourceRow,
} from "@/lib/knowledge-service";
import type { KnowledgeRouteDeps } from "@/lib/knowledge-route";

// Central Knowledge Base — Supabase persistence (Phase A4). SERVER ONLY.
//
// Uses the service-role client (the browser has no access to these tables:
// deny-all RLS + revoked grants, migration 0065). EVERY query is filtered by
// the session workspace passed in by the route wrapper; a row of another
// workspace can never be read, changed or deleted through this module.
//
// Document changes and duplicates go through the two 0065 database functions
// (knowledge_apply_document_changes / knowledge_duplicate_resource), each ONE
// transaction: the document write and the content_version increment — or the
// resource and all its copied documents — commit together or not at all. This
// module never writes knowledge_documents directly and never sets
// content_version or status.
//
// Errors: a missing table or function → KnowledgeMigrationMissing (→ 503);
// database constraints map to typed results (unique → conflict, the 50-document
// trigger → limit, the assignment foreign key → "assigned", P0002 → not found);
// anything else throws a generic error carrying only the Postgres error code —
// never SQL text or knowledge content.

/* eslint-disable @typescript-eslint/no-explicit-any */

type PgError = { code?: string; message?: string; details?: string; hint?: string } | null;

const RES = "knowledge_resources";
const DOCS = "knowledge_documents";
const ASSIGN = "agent_knowledge_resources";
const DOC_META = "id, workspace_id, resource_id, kind, source_url, filename, mime, content_hash, char_count, fetched_at, status, error, position, created_at, updated_at";

export function isMissingTable(error: PgError): boolean {
  if (!error) return false;
  // 42P01 / PGRST205: table missing. 42883 / PGRST202: function missing.
  return (
    error.code === "42P01" || error.code === "PGRST205" || error.code === "42883" || error.code === "PGRST202" ||
    /relation .* does not exist|could not find the (table|function)/i.test(error.message ?? "")
  );
}

class KnowledgeStoreError extends Error {
  constructor(code: string | undefined) {
    super(`Knowledge store error${code ? ` (${code})` : ""}`);
    this.name = "KnowledgeStoreError";
  }
}

/** Throw on any unexpected error; migration-missing becomes its own error. */
function check(error: PgError): void {
  if (!error) return;
  if (isMissingTable(error)) throw new KnowledgeMigrationMissing();
  throw new KnowledgeStoreError(error.code);
}

const asDoc = (r: any, withContent: boolean): DocumentRow => ({ ...r, content: withContent ? String(r.content ?? "") : "" });

/** Flat JSON for one change (the shape knowledge_apply_document_changes reads). No workspace / resource ids: the function takes those from its parameters. */
function toChangeJson(c: DocumentChange): Record<string, unknown> {
  switch (c.op) {
    case "insert":
      return { op: "insert", ...c.doc };
    case "replace":
      return { op: "replace", id: c.id, optional: !!c.optional, ...c.doc };
    case "touch": {
      const out: Record<string, unknown> = { op: "touch", id: c.id, optional: !!c.optional };
      if (c.fetched_at !== undefined) out.fetched_at = c.fetched_at;
      if (c.error !== undefined) out.error = c.error;
      return out;
    }
    case "delete":
      return { op: "delete", id: c.id, optional: !!c.optional };
  }
}

export const knowledgeStore: KnowledgeStore = {
  async listResources(ws) {
    const { data, error } = await supabase.from(RES).select("*").eq("workspace_id", ws);
    check(error);
    return (data ?? []) as ResourceRow[];
  },
  async getResource(ws, id) {
    const { data, error } = await supabase.from(RES).select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
    if (error?.code === "22P02") return null; // malformed id
    check(error);
    return (data as ResourceRow) ?? null;
  },
  async insertResource(ws, row) {
    const { data, error } = await supabase.from(RES).insert({ ...row, workspace_id: ws }).select("*").single();
    if (error?.code === "23505") return { conflict: "name" };
    check(error);
    return { row: data as ResourceRow };
  },
  async updateResource(ws, id, patch) {
    const { data, error } = await supabase.from(RES).update(patch).eq("workspace_id", ws).eq("id", id).select("*");
    if (error?.code === "23505") return { conflict: "name" };
    if (error?.code === "22P02") return null;
    check(error);
    return Array.isArray(data) && data.length === 1 ? { row: data[0] as ResourceRow } : null;
  },
  async deleteResource(ws, id) {
    const { data, error } = await supabase.from(RES).delete().eq("workspace_id", ws).eq("id", id).select("id");
    if (error?.code === "23503") return "assigned"; // agent_knowledge_resources NO ACTION FK
    check(error);
    return Array.isArray(data) && data.length === 1 ? "deleted" : "not_found";
  },
  async listDocuments(ws, resourceId, opts) {
    const { data, error } = await supabase
      .from(DOCS)
      .select(opts.withContent ? `${DOC_META}, content` : DOC_META)
      .eq("workspace_id", ws)
      .eq("resource_id", resourceId)
      .order("position");
    check(error);
    return (data ?? []).map((r: any) => asDoc(r, opts.withContent));
  },
  async listDocumentStats(ws) {
    const { data, error } = await supabase.from(DOCS).select("resource_id, char_count").eq("workspace_id", ws);
    check(error);
    return (data ?? []).map((r: any) => ({ resource_id: String(r.resource_id), char_count: Number(r.char_count ?? 0) }));
  },
  async applyDocumentChanges(ws, resourceId, userId, changes, meta) {
    const { data, error } = await supabase.rpc("knowledge_apply_document_changes", {
      p_workspace_id: ws,
      p_resource_id: resourceId,
      p_user_id: userId,
      p_changes: changes.map(toChangeJson),
      p_resource: meta,
    });
    if (error?.code === "P0002") return { notFound: error.hint === "document" ? "document" : "resource" };
    if (error?.code === "22P02") return { notFound: "resource" };
    if (error?.code === "23514" && /at most 50 documents/i.test(error.message ?? "")) return { limit: true };
    if (error?.code === "23505") return { conflict: true };
    check(error);
    const out = data as { resource: ResourceRow; changed: boolean; results: ChangeResult[] };
    return { row: out.resource, changed: !!out.changed, results: out.results ?? [] };
  },
  async duplicateResource(ws, sourceId, name, userId) {
    const { data, error } = await supabase.rpc("knowledge_duplicate_resource", {
      p_workspace_id: ws,
      p_source_id: sourceId,
      p_name: name,
      p_user_id: userId,
    });
    if (error?.code === "P0002" || error?.code === "22P02") return { notFound: true };
    if (error?.code === "23505") return { conflict: "name" };
    check(error);
    const out = data as { resource: ResourceRow; documents: number };
    return { row: out.resource, documents: Number(out.documents ?? 0) };
  },
  async listAssignments(ws, resourceIds) {
    let q = supabase.from(ASSIGN).select("resource_id, agent_id, agents(name)").eq("workspace_id", ws);
    if (resourceIds) {
      if (!resourceIds.length) return [];
      q = q.in("resource_id", resourceIds);
    }
    const { data, error } = await q;
    check(error);
    return (data ?? []).map(
      (r: any): AssignmentRow => ({ resource_id: String(r.resource_id), agent_id: String(r.agent_id), agent_name: String((Array.isArray(r.agents) ? r.agents[0]?.name : r.agents?.name) ?? "") })
    );
  },
};

/** Production dependencies for one request: session auth, service-role store, A3 ingestion. */
export function knowledgeDeps(req: NextRequest): KnowledgeRouteDeps {
  return {
    authorize: () => authorizeRequest(req),
    serviceRoleConfigured,
    store: knowledgeStore,
    ingest: (workspaceId) => ({
      extract: async (file) => {
        const r = await extractDocument(file);
        return r.ok ? { ok: true, text: r.text } : { ok: false, status: r.status, error: r.error };
      },
      importSite: async (url) => {
        try {
          // The workspace for engine credentials is the SESSION workspace.
          const r = await importWebsite(url, defaultWebsiteDeps(engineFetchForWorkspace(workspaceId)));
          return r.ok ? { ok: true, text: r.text } : { ok: false, status: r.status, error: r.error, code: r.code };
        } catch {
          // An unexpected error inside the importer (never an SSRF refusal — those
          // come back as a 400 result): report a fetch failure, keep content.
          return { ok: false, status: 502, error: "The website could not be fetched.", code: "fetch_failed" };
        }
      },
    }),
    now: () => new Date(),
  };
}
