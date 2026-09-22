// Structured cores for the patient / knowledge tools shared by the LiveKit
// worker's tool-exec endpoint and the Builder HTTP tool adapter. Each core
// returns machine-readable facts about what ACTUALLY happened (never inferred
// from prose); the matching *Spoken() formatter reproduces the exact sentences
// the voice worker has always received, so refactoring tool-exec onto these
// cores changes nothing the worker sees.

import { supabaseAdmin as supabase } from "@/lib/supabase-admin";
import { retrieveKnowledge } from "@/lib/kb-retrieval";

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
}

// The per-turn knowledge retrieval both channels share: the SAME retrieval
// code the chat agents use (lib/kb-retrieval.ts) over the agent's stored
// knowledge base. Returns top chunks with their source names.
export async function searchKnowledgeCore(
  agent: { name?: string | null; knowledge_base?: string | null },
  a: { query?: unknown; context?: unknown },
  channel = "voice"
): Promise<KnowledgeResult> {
  const query = String(a.query ?? "").trim();
  if (!query) return { success: false, error: "missing_query", found: false, text: "", sources: [] };
  const started = Date.now();
  const r = retrieveKnowledge(String(agent.knowledge_base ?? ""), [query, String(a.context ?? "")], {
    budget: 6000,
    relevantBudget: 6000,
    topK: 4,
  });
  // Small KBs come back whole ("full" mode) — trim to the budget for a voice turn.
  const text = r.mode === "full" ? r.text.slice(0, 6000) : r.text;
  // Observability: sources + scores + latency, never the knowledge text itself.
  console.log(
    `[kb-retrieval] agent=${agent.name} channel=${channel} mode=${r.mode} kb_chars=${r.totalKbChars} latency_ms=${Date.now() - started} top=${r.chunks.map((c) => `${c.source}#${c.id}:${c.score}`).slice(0, 4).join(", ") || "(full)"}`
  );
  return {
    success: true,
    found: !!text.trim(),
    text,
    sources: r.chunks.slice(0, 4).map((c) => ({ source: c.source, id: c.id, score: c.score })),
  };
}

export function searchKnowledgeSpoken(r: KnowledgeResult): string {
  if (r.error === "missing_query") return "Provide a query describing what to look up.";
  if (!r.found) return "The knowledge base has no information about that.";
  return `Relevant clinic knowledge (answer ONLY from this; if the specific fact isn't here, say you don't have it):\n${r.text}`;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
