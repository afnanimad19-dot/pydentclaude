// Structured cores for the patient / knowledge tools shared by the LiveKit
// worker's tool-exec endpoint and the Builder HTTP tool adapter. Each core
// returns machine-readable facts about what ACTUALLY happened (never inferred
// from prose); the matching *Spoken() formatter reproduces the exact sentences
// the voice worker has always received, so refactoring tool-exec onto these
// cores changes nothing the worker sees.

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { retrieveKnowledge, tokenize, expandQuery, queriesFromMessages, type RetrievalResult } from "@/lib/kb-retrieval";
import {
  loadAgentCentralKnowledge,
  matchAgentChunks,
  type CentralKnowledgeState,
  type CentralKnowledgeLoader,
  type ChunkMatcher,
  type ChunkMatch,
} from "@/lib/knowledge-runtime";

/* eslint-disable @typescript-eslint/no-explicit-any */

// ── lookup_patient ───────────────────────────────────────────────────────────
export interface PatientHit {
  id: string;                        // Pydent patient UUID (NOT an Open Dental PatNum)
  name: string | null;
  phone: string | null;
  email: string | null;
  next_appointment: string | null;
  insurance: string | null;
}

export interface LookupPatientResult {
  success: boolean;
  error?: string;                    // "missing_query"
  found: boolean;
  patients: PatientHit[];
}

// Lookup prefers phone (digits-only, last-9 match); falls back to email, then
// name. The voice worker only ever passes phone/name, so its behaviour is
// unchanged; the Builder adapter also accepts email.
export async function lookupPatientCore(ws: string | null, q: { phone?: unknown; name?: unknown; email?: unknown }): Promise<LookupPatientResult> {
  const phone = String(q.phone ?? "").replace(/[^0-9+]/g, "");
  const name = String(q.name ?? "").trim();
  const email = String(q.email ?? "").trim();
  if (!phone && !name && !email) return { success: false, error: "missing_query", found: false, patients: [] };
  const sel = supabase.from("patients").select("id, name, phone, email, next_appointment, insurance").eq("workspace_id", ws);
  const { data } = phone
    ? await sel.ilike("phone", `%${phone.replace(/^\+/, "").slice(-9)}%`).limit(3)
    : email
      ? await sel.ilike("email", email).limit(3)
      : await sel.ilike("name", `%${name}%`).limit(3);
  const patients = (data ?? []) as PatientHit[];
  return { success: true, found: patients.length > 0, patients };
}

// One patient by its Pydent UUID, workspace-scoped. Used by the Builder
// adapter to validate a caller-supplied patient_id before acting on it.
export async function getPatientById(ws: string | null, id: string): Promise<PatientHit | null> {
  if (!id) return null;
  try {
    const { data } = await supabase
      .from("patients")
      .select("id, name, phone, email, next_appointment, insurance")
      .eq("workspace_id", ws)
      .eq("id", id)
      .maybeSingle();
    return (data as PatientHit | null) ?? null;
  } catch {
    // A malformed UUID makes Postgres reject the query — same as no match.
    return null;
  }
}

export function lookupPatientSpoken(r: LookupPatientResult): string {
  if (r.error === "missing_query") return "Provide a phone number or a name to look up.";
  if (!r.found) return "No matching patient record found — they may be a new patient.";
  return r.patients
    .map((p: any) => `Found: ${p.name}${p.phone ? `, phone ${p.phone}` : ""}${p.email ? `, email ${p.email}` : ""}${p.next_appointment ? `, next appointment ${p.next_appointment}` : ""}${p.insurance ? `, insurance ${p.insurance}` : ""}`)
    .join("\n");
}

// ── create_patient ───────────────────────────────────────────────────────────
export interface CreatePatientResult {
  success: boolean;
  error?: string;                    // "missing_name" or the DB error message
  created: boolean;
  duplicate?: boolean;
  existingName?: string;
  patientId?: string | null;         // Pydent UUID of the new record, when returned
  name?: string;
}

// Dedupes by phone so a repeat caller never becomes a duplicate record.
export async function createPatientCore(
  ws: string | null,
  agentName: string,
  q: { name?: unknown; phone?: unknown; email?: unknown }
): Promise<CreatePatientResult> {
  const name = String(q.name ?? "").trim();
  const phone = String(q.phone ?? "").replace(/[^0-9+]/g, "");
  const email = String(q.email ?? "").trim();
  if (!name) return { success: false, error: "missing_name", created: false };
  if (phone) {
    const { data: existing } = await supabase
      .from("patients").select("id, name").eq("workspace_id", ws)
      .ilike("phone", `%${phone.replace(/^\+/, "").slice(-9)}%`).limit(1);
    if (existing?.length) return { success: true, created: false, duplicate: true, existingName: String(existing[0].name ?? ""), patientId: existing[0].id };
  }
  const { data: created, error } = await supabase.from("patients").insert({
    workspace_id: ws, name, phone, email, status: "New",
    source_channel: "voice", source_agent: agentName,
  }).select("id").single();
  if (error) {
    // Older DBs may lack source columns — retry with the core fields.
    const { data: created2, error: e2 } = await supabase.from("patients").insert({ workspace_id: ws, name, phone, email, status: "New" }).select("id").single();
    if (e2) return { success: false, error: e2.message, created: false, name };
    return { success: true, created: true, patientId: created2?.id ?? null, name };
  }
  return { success: true, created: true, patientId: created?.id ?? null, name };
}

export function createPatientSpoken(r: CreatePatientResult): string {
  if (r.error === "missing_name") return "A name is required to create a patient record.";
  if (r.duplicate) return `A record already exists for this phone number (${r.existingName}) — no duplicate was created.`;
  if (!r.success) return `Could not create the record: ${r.error}`;
  return `Created a new patient record for ${r.name}.`;
}

// ── search_knowledge ─────────────────────────────────────────────────────────
export interface KnowledgeResult {
  success: boolean;
  error?: string;                    // "missing_query"
  found: boolean;
  text: string;
  sources: { source: string; id: number; score: number }[];
  /** Which store answered this turn: the 0068 chunk index, the assigned
   *  Central documents (lexical), or the legacy per-agent blob. */
  sourceMode?: "central-chunks" | "central" | "legacy";
}

export const FTS_MAX_TERMS = 24;

/**
 * Shape conversation text into a websearch_to_tsquery-friendly query.
 * websearch ANDs plain words, so a whole sentence would match almost nothing;
 * instead the SAME tokenization + abbreviation expansion the lexical engine
 * uses produces distinct terms OR-ed together — ts_rank_cd still rewards the
 * chunks that match more of them.
 */
export function ftsQueryFor(queries: readonly string[]): string {
  const seen = new Set<string>();
  for (const q of queries) {
    if (!q || !q.trim()) continue;
    for (const t of tokenize(expandQuery(q))) {
      if (seen.size >= FTS_MAX_TERMS) break;
      seen.add(t);
    }
    if (seen.size >= FTS_MAX_TERMS) break;
  }
  return [...seen].join(" OR ");
}

/** "Source label · heading" attribution line for one chunk (no ids, no newlines). */
function chunkSourceLine(m: ChunkMatch): string {
  return [String(m.sourceLabel || "Knowledge resource"), String(m.heading || "")]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" · ")
    .replace(/\s+/g, " ");
}

/**
 * Chunk sections with their source attribution, within a hard char budget.
 * Order (the function's score-then-position order) is preserved; the first
 * chunk is always included (truncated if it alone exceeds the budget).
 */
export function formatChunkSections(matches: readonly ChunkMatch[], budget: number): { text: string; used: ChunkMatch[] } {
  const parts: string[] = [];
  const used: ChunkMatch[] = [];
  let len = 0;
  for (const m of matches) {
    const section = `--- ${chunkSourceLine(m)} ---\n${m.content}`;
    if (!used.length) {
      parts.push(section.length > budget ? section.slice(0, budget) : section);
      used.push(m);
      len = Math.min(section.length, budget);
      continue;
    }
    if (len + 2 + section.length > budget) break;
    parts.push(section);
    used.push(m);
    len += 2 + section.length;
  }
  return { text: parts.join("\n\n"), used };
}

/** What one central search decided and produced (observability fields never carry content). */
interface CentralSearchOutcome {
  sourceMode: "central-chunks" | "central" | "legacy";
  retrieval: RetrievalResult;
  searchedChunks?: number;
  central?: CentralKnowledgeState;
}

// The retrieval ladder (Phase 2C, operator-approved semantics):
//   1. knowledge_match_chunks (0068) is PRIMARY. Its searched_chunks value is
//      the agent's authoritative chunk universe:
//      • universe > 0 with matches → answer from those chunks;
//      • universe > 0 with NO matches → genuine no-match — retrieval is never
//        broadened past what the live index already covers;
//      • universe = 0 → no usable index (not an error) → step 2.
//   2. The existing Phase 1B path, unchanged: assigned Central documents are
//      searched lexically; an assigned agent with nothing usable truthfully
//      has nothing (never the stale legacy blob); an UNASSIGNED agent uses
//      the legacy agents.knowledge_base exactly as before.
//   An RPC failure in step 1 (0068 missing, network, bad shape) falls back to
//   step 2 — the controlled, already-authorized path — never to a dead tool.
//   Workspace and agent ids come from the caller's server-resolved context.
async function runCentralSearch(
  agent: { id?: string | null; workspace_id?: string | null; name?: string | null; knowledge_base?: string | null },
  queries: readonly string[],
  opts: { budget: number; relevantBudget: number; topK: number },
  loadCentral: CentralKnowledgeLoader,
  matchChunks: ChunkMatcher
): Promise<CentralSearchOutcome> {
  const ws = String(agent.workspace_id ?? "");
  const agentId = String(agent.id ?? "");
  const fts = ftsQueryFor(queries);
  if (fts) {
    const m = await matchChunks(ws, agentId, fts, Math.min(opts.topK, 20));
    if (m.ok && m.searchedChunks > 0) {
      const { text, used } = formatChunkSections(m.matches, opts.relevantBudget);
      return {
        sourceMode: "central-chunks",
        searchedChunks: m.searchedChunks,
        retrieval: {
          text,
          mode: used.length ? "retrieved" : "empty",
          chunks: used.map((c) => ({
            source: chunkSourceLine(c),
            id: c.chunkIndex,
            score: Math.round(c.score * 100) / 100,
            chars: c.content.length,
            preview: c.content.slice(0, 120),
          })),
          totalKbChars: text.length,
          contextChars: text.length,
        },
      };
    }
  }
  let central: CentralKnowledgeState = { assigned: false, knowledge: null };
  try {
    central = await loadCentral(ws, agentId);
  } catch {
    central = { assigned: false, knowledge: null }; // migration state unknowable → legacy keeps the call alive
  }
  const sourceMode: "central" | "legacy" = central.assigned ? "central" : "legacy";
  const kb = central.assigned ? central.knowledge?.text ?? "" : String(agent.knowledge_base ?? "");
  return {
    sourceMode,
    central,
    retrieval: retrieveKnowledge(
      kb,
      queries.filter((q) => q && q.trim()),
      opts
    ),
  };
}

function logCentralSearch(agentName: unknown, channel: string, out: CentralSearchOutcome, startedAt: number): void {
  const r = out.retrieval;
  // Observability: source mode, counts, sources + scores + latency — never the knowledge text itself.
  console.log(
    `[kb-retrieval] agent=${agentName} channel=${channel} source=${out.sourceMode}${out.sourceMode === "central-chunks" ? ` searched_chunks=${out.searchedChunks}` : ""}${out.central?.assigned ? ` resources=${out.central.knowledge?.resources ?? 0} documents=${out.central.knowledge?.documents ?? 0}` : ""} mode=${r.mode} kb_chars=${r.totalKbChars} latency_ms=${Date.now() - startedAt} top=${r.chunks.map((c) => `${c.source}#${c.id}:${c.score}`).slice(0, 4).join(", ") || "(full)"}`
  );
}

// The per-turn knowledge retrieval shared by the LiveKit worker's tool-exec
// endpoint and the Builder adapter (and, via centralRetrievalForReply, the
// text channels). Spoken wrapper and tool contract are unchanged — the worker
// sees no difference between source modes.
export async function searchKnowledgeCore(
  agent: { id?: string | null; workspace_id?: string | null; name?: string | null; knowledge_base?: string | null },
  a: { query?: unknown; context?: unknown },
  channel = "voice",
  loadCentral: CentralKnowledgeLoader = loadAgentCentralKnowledge,
  matchChunks: ChunkMatcher = matchAgentChunks
): Promise<KnowledgeResult> {
  const query = String(a.query ?? "").trim();
  if (!query) return { success: false, error: "missing_query", found: false, text: "", sources: [] };
  const started = Date.now();
  const out = await runCentralSearch(agent, [query, String(a.context ?? "")], { budget: 6000, relevantBudget: 6000, topK: 4 }, loadCentral, matchChunks);
  const r = out.retrieval;
  // Small KBs come back whole ("full" mode) — trim to the budget for a voice turn.
  const text = r.mode === "full" ? r.text.slice(0, 6000) : r.text;
  logCentralSearch(agent.name, channel, out, started);
  return {
    success: true,
    found: !!text.trim(),
    text,
    sources: r.chunks.slice(0, 4).map((c) => ({ source: c.source, id: c.id, score: c.score })),
    sourceMode: out.sourceMode,
  };
}

// ── central retrieval for text-channel replies (Phase 2C) ────────────────────

/** Injected into the prompt when the live index holds nothing for this
 *  question: grounding survives even though no knowledge text matched. */
export const NO_MATCH_PROMPT_NOTE =
  "No stored clinic knowledge matched this question. For clinic-specific facts (doctors, services, prices, hours, credentials), say you don't have that detail on hand and offer to check with the team — never guess.";

export interface ReplyRetrieval {
  retrieval: RetrievalResult;
  sourceMode: "central-chunks" | "central";
}

/**
 * Per-turn Central Knowledge retrieval for TEXT channels (WhatsApp, SMS, the
 * authenticated dashboard chat). Callers MUST have resolved the agent row and
 * workspace server-side (webhook → channel → workspace → agent, or a
 * session-authorized lookup) — nothing here may be fed from a request body.
 *
 * Returns null for a legacy (unassigned) agent, so callers keep today's
 * knowledgeBase path byte-for-byte. For a central agent the result is a
 * RetrievalResult to inject into generateAgentReply; when nothing matched
 * (or nothing is usable yet) the text is NO_MATCH_PROMPT_NOTE so the
 * grounding rules stay in the prompt without broadening retrieval.
 * One call per conversation turn — compute once, pass it down.
 */
export async function centralRetrievalForReply(
  agent: { id?: string | null; workspace_id?: string | null; name?: string | null; knowledge_base?: string | null },
  messages: { role: string; content: string }[],
  channel: string,
  loadCentral: CentralKnowledgeLoader = loadAgentCentralKnowledge,
  matchChunks: ChunkMatcher = matchAgentChunks
): Promise<ReplyRetrieval | null> {
  const started = Date.now();
  const out = await runCentralSearch(agent, queriesFromMessages(messages ?? []), { budget: 48000, relevantBudget: 12000, topK: 8 }, loadCentral, matchChunks);
  if (out.sourceMode === "legacy") return null;
  logCentralSearch(agent.name, channel, out, started);
  const retrieval = out.retrieval.text.trim()
    ? out.retrieval
    : { ...out.retrieval, text: NO_MATCH_PROMPT_NOTE, mode: "empty" as const, chunks: [] };
  return { retrieval, sourceMode: out.sourceMode };
}

export function searchKnowledgeSpoken(r: KnowledgeResult): string {
  if (r.error === "missing_query") return "Provide a query describing what to look up.";
  if (!r.found) return "The knowledge base has no information about that.";
  return `Relevant clinic knowledge (answer ONLY from this; if the specific fact isn't here, say you don't have it):\n${r.text}`;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
