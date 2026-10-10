// Central Knowledge — RUNTIME reader (Phase 1B). SERVER ONLY.
//
// The ONE sanctioned runtime path into the 0065 tables: given the agent that is
// answering, load the Central Knowledge text its assignments grant it, for the
// existing lexical engine (lib/kb-retrieval.ts) to search. Everything else about
// retrieval (chunking, ranking, budgets, the grounding wrapper) is unchanged.
//
// Tenancy is enforced three times over:
//   • every query filters by the AUTHENTICATED workspace (the callers resolve
//     it server-side — tool-exec / the Builder adapter via the worker token);
//   • assignments are read by (workspace_id, agent_id), so only this agent's
//     own links decide which resources are even looked at;
//   • resources and documents are then loaded by (workspace_id, id/resource_id)
//     — a resource id of another workspace loads nothing.
// An unassigned resource can never be included: resource ids come ONLY from
// the agent's assignment rows, never from input.
//
// Usable knowledge = an assigned resource's documents with status 'ready' and
// non-blank content (resource status derives from documents, so the document
// filter is authoritative). No usable documents → null → the caller falls back
// to the legacy agents.knowledge_base blob. Loader errors (including the 0065
// tables not being installed) also yield null: a live call degrades to the
// legacy behaviour it always had, never to a dead tool.
//
// Ordering is deterministic: assignment position (Phase 1A appends per agent),
// then resource id; documents by their position, then id.
//
// This module uses the service-role client and must never be imported by
// browser code (guarded by tests/knowledge-ui.test.mjs). Nothing here logs
// knowledge content.

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";

export interface CentralAssignmentRow {
  resource_id: string;
  position: number;
}
export interface CentralResourceRow {
  id: string;
  name: string;
}
export interface CentralDocumentRow {
  id: string;
  resource_id: string;
  filename: string | null;
  source_url: string | null;
  content: string;
  position: number;
}

export interface AgentCentralKnowledge {
  /** "--- Resource / document ---" sections in assignment order (kb-retrieval's marker convention). */
  text: string;
  /** Usable resources / documents included (metadata for logs — never content). */
  resources: number;
  documents: number;
  chars: number;
}

/**
 * What the runtime knows about an agent's Central Knowledge (Phase 1C).
 * `assigned` is the MIGRATION SIGNAL: at least one assignment exists, however
 * its documents are doing. An assigned agent whose documents are all
 * processing/error/blank gets `knowledge: null` — it stays in central mode
 * with nothing to answer from (never a silent fall back to the legacy blob).
 */
export interface CentralKnowledgeState {
  assigned: boolean;
  knowledge: AgentCentralKnowledge | null;
}

export type CentralKnowledgeLoader = (ws: string, agentId: string) => Promise<CentralKnowledgeState>;

const NOT_ASSIGNED: CentralKnowledgeState = { assigned: false, knowledge: null };

/** One-line source label: "Resource name / file-or-url" (no ids, no newlines). */
export function centralSourceLabel(resourceName: string, doc: Pick<CentralDocumentRow, "filename" | "source_url">): string {
  const docLabel = String(doc.filename ?? doc.source_url ?? "Document").trim() || "Document";
  return `${String(resourceName).trim() || "Knowledge resource"} / ${docLabel}`.replace(/\s+/g, " ");
}

/**
 * Pure: compose the agent's Central Knowledge from already-scoped rows.
 * Returns null when nothing usable remains — the caller's fallback signal.
 */
export function buildAgentCentralKnowledge(
  assignments: readonly CentralAssignmentRow[],
  resources: readonly CentralResourceRow[],
  documents: readonly CentralDocumentRow[]
): AgentCentralKnowledge | null {
  const byResource = new Map<string, CentralDocumentRow[]>();
  for (const d of documents) {
    if (!String(d.content ?? "").trim()) continue; // blank content is not knowledge
    const list = byResource.get(String(d.resource_id)) ?? [];
    list.push(d);
    byResource.set(String(d.resource_id), list);
  }
  const names = new Map(resources.map((r) => [String(r.id), String(r.name ?? "")]));
  const ordered = assignments
    .slice()
    .sort((a, b) => a.position - b.position || String(a.resource_id).localeCompare(String(b.resource_id)));
  const sections: string[] = [];
  let usedResources = 0;
  let usedDocuments = 0;
  for (const a of ordered) {
    const rid = String(a.resource_id);
    if (!names.has(rid)) continue; // not readable in this workspace → not included
    const docs = (byResource.get(rid) ?? []).sort((x, y) => x.position - y.position || String(x.id).localeCompare(String(y.id)));
    if (!docs.length) continue;
    usedResources++;
    for (const d of docs) {
      usedDocuments++;
      sections.push(`--- ${centralSourceLabel(names.get(rid) ?? "", d)} ---\n${String(d.content)}`);
    }
  }
  if (!sections.length) return null;
  const text = sections.join("\n\n");
  return { text, resources: usedResources, documents: usedDocuments, chars: text.length };
}

/**
 * Load the Central Knowledge state of ONE agent of ONE workspace (service
 * role; both ids come from the server's own authenticated context, never from
 * tool arguments).
 *
 * Failure split (Phase 1C): when the ASSIGNMENT lookup itself fails — the 0065
 * tables aren't installed, or the query errors — the agent's migration state is
 * unknown and the result is `assigned: false` (the tool keeps its legacy path,
 * so a live call never dies). But once assignments are KNOWN to exist, a
 * failing or empty document load yields `assigned: true, knowledge: null`: a
 * migrated agent is never silently handed the stale legacy blob.
 */
export async function loadAgentCentralKnowledge(ws: string, agentId: string): Promise<CentralKnowledgeState> {
  if (!ws || !agentId) return NOT_ASSIGNED;
  try {
    const { data: assignments, error: aErr } = await supabase
      .from("agent_knowledge_resources")
      .select("resource_id, position")
      .eq("workspace_id", ws)
      .eq("agent_id", agentId);
    if (aErr || !assignments?.length) return NOT_ASSIGNED;
    const ids = assignments.map((a) => String(a.resource_id));
    const [resQ, docQ] = await Promise.all([
      supabase.from("knowledge_resources").select("id, name").eq("workspace_id", ws).in("id", ids),
      supabase
        .from("knowledge_documents")
        .select("id, resource_id, filename, source_url, content, position")
        .eq("workspace_id", ws)
        .in("resource_id", ids)
        .eq("status", "ready"),
    ]);
    if (resQ.error || docQ.error) return { assigned: true, knowledge: null };
    return {
      assigned: true,
      knowledge: buildAgentCentralKnowledge(
        assignments as CentralAssignmentRow[],
        (resQ.data ?? []) as CentralResourceRow[],
        (docQ.data ?? []) as CentralDocumentRow[]
      ),
    };
  } catch {
    return NOT_ASSIGNED; // migration state unknowable: the live call keeps its legacy path
  }
}

// ------------------------------------------------------------------ prompt mode (Phase 1C)

export type KnowledgePromptMode = "central" | "legacy";

type PgErrorLike = { code?: string; message?: string } | null | undefined;

/** 42P01 / PGRST205: the 0065 tables aren't installed — nobody can be migrated. */
function centralTablesMissing(e: PgErrorLike): boolean {
  return e?.code === "42P01" || e?.code === "PGRST205" || /relation .* does not exist|could not find the table/i.test(e?.message ?? "");
}

/** Does at least one assignment exist? (Injectable for tests; never reads documents.) */
export type AssignmentProbe = (ws: string, agentId: string) => Promise<{ assigned: boolean } | { error: PgErrorLike }>;

const defaultAssignmentProbe: AssignmentProbe = async (ws, agentId) => {
  const { data, error } = await supabase
    .from("agent_knowledge_resources")
    .select("resource_id")
    .eq("workspace_id", ws)
    .eq("agent_id", agentId)
    .limit(1);
  if (error) return { error };
  return { assigned: (data ?? []).length > 0 };
};

/**
 * The LiveKit prompt's knowledge mode for one agent (Phase 1C migration state).
 *
 * "central" ⇔ the agent has at least ONE Central Knowledge assignment — the
 * stable operator decision. Document readiness NEVER enters this decision: an
 * assigned agent whose documents are processing/error/blank stays central, so
 * the stale legacy blob is never re-injected into its prompt.
 *
 * Failure policy: the 0065 tables missing → "legacy" (nobody can be migrated).
 * Any OTHER lookup failure → "central": the prompt does WITHOUT the blob, which
 * is safe because search_knowledge still serves the correct store either way
 * (its own loader falls back to legacy for a truly-legacy agent) — preferring a
 * missing blob over a possibly-stale cross-source prompt.
 */
export async function knowledgePromptMode(ws: string, agentId: string, probe: AssignmentProbe = defaultAssignmentProbe): Promise<KnowledgePromptMode> {
  if (!ws || !agentId) return "legacy";
  let r: Awaited<ReturnType<AssignmentProbe>>;
  try {
    r = await probe(ws, agentId);
  } catch {
    r = { error: {} };
  }
  if ("assigned" in r) return r.assigned ? "central" : "legacy";
  return centralTablesMissing(r.error) ? "legacy" : "central";
}

// ------------------------------------------------------------------ chunk retrieval (Phase 2C)

/** One authoritative chunk row returned by knowledge_match_chunks (0068). */
export interface ChunkMatch {
  resourceId: string;
  documentId: string;
  chunkId: string;
  chunkIndex: number;
  sourceLabel: string;
  heading: string;
  content: string;
  score: number;
}

/**
 * Result of one chunk search. `searchedChunks` is the agent's AUTHORITATIVE
 * chunk universe — assigned resources → 'ready' documents → chunks whose
 * content_hash matches the document (the 0068 join re-proves all of it).
 * The operator-approved semantics hang off that number:
 *   • ok, searchedChunks > 0, matches present → answer from the chunks;
 *   • ok, searchedChunks > 0, no matches     → GENUINE no-match: retrieval is
 *     never broadened past what the index already covers;
 *   • ok, searchedChunks === 0 → no usable index for this agent (not an
 *     error) → the caller keeps the existing assigned-document retrieval;
 *   • ok: false → the RPC itself failed (0068 missing, network, bad shape)
 *     → controlled fallback to the existing authorized path.
 */
export type ChunkMatchResult =
  | { ok: true; searchedChunks: number; matches: ChunkMatch[] }
  | { ok: false; error: "rpc_failed" | "bad_response" };

export type ChunkMatcher = (ws: string, agentId: string, query: string, topK?: number) => Promise<ChunkMatchResult>;

const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

/**
 * Strict parse of the function's jsonb. Any malformed row fails the WHOLE
 * response (ok: false) — a half-understood result must never masquerade as a
 * genuine no-match, so shape errors route callers to the fallback path.
 */
export function parseChunkMatchResponse(data: unknown): ChunkMatchResult {
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "bad_response" };
  const o = data as Record<string, unknown>;
  const universe = typeof o.searched_chunks === "number" ? o.searched_chunks : Number.NaN;
  if (!Number.isFinite(universe) || universe < 0) return { ok: false, error: "bad_response" };
  if (!Array.isArray(o.matches)) return { ok: false, error: "bad_response" };
  const matches: ChunkMatch[] = [];
  for (const m of o.matches) {
    if (!m || typeof m !== "object" || Array.isArray(m)) return { ok: false, error: "bad_response" };
    const r = m as Record<string, unknown>;
    const content = asStr(r.content);
    const score = typeof r.score === "number" ? r.score : Number.NaN;
    if (!asStr(r.chunk_id) || !content.trim() || !Number.isFinite(score)) return { ok: false, error: "bad_response" };
    matches.push({
      resourceId: asStr(r.resource_id),
      documentId: asStr(r.document_id),
      chunkId: asStr(r.chunk_id),
      chunkIndex: typeof r.chunk_index === "number" && Number.isFinite(r.chunk_index) ? r.chunk_index : 0,
      sourceLabel: asStr(r.source_label),
      heading: asStr(r.heading),
      content,
      score,
    });
  }
  return { ok: true, searchedChunks: universe, matches };
}

/**
 * Tenant+agent-scoped chunk search via knowledge_match_chunks (0068, service
 * role). Both ids come from the server's own authenticated context — never
 * from tool arguments or request bodies — and the SQL re-proves workspace
 * agreement on every join, so an unassigned or foreign resource can never
 * contribute a row. Never throws, never logs knowledge content.
 */
export async function matchAgentChunks(ws: string, agentId: string, query: string, topK = 8): Promise<ChunkMatchResult> {
  // Blank identity can never have an index — same semantics as universe 0,
  // and the caller's existing path already handles blank ids correctly.
  if (!ws || !agentId) return { ok: true, searchedChunks: 0, matches: [] };
  try {
    const { data, error } = await supabase.rpc("knowledge_match_chunks", {
      p_workspace_id: ws,
      p_agent_id: agentId,
      p_query: String(query ?? ""),
      p_top_k: Math.max(1, Math.min(Math.trunc(topK) || 8, 20)),
    });
    if (error) return { ok: false, error: "rpc_failed" };
    return parseChunkMatchResponse(data);
  } catch {
    return { ok: false, error: "rpc_failed" };
  }
}
