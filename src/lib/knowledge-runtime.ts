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
