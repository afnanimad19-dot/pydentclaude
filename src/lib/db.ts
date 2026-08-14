// Live data layer (Supabase) with graceful fallback to the bundled demo
// dataset when the database is unreachable or hasn't been migrated yet.

import { supabase } from "./supabase";
import {
  type Patient,
  type Appointment,
  type TreatmentPlan,
  type PatientDocument,
  type InsurancePolicy,
  type Payment,
} from "./mock-data";

export type DataSource = "live" | "demo";

// Current clinic's workspace id (multi-tenant). The cache is BOUND TO THE USER ID,
// so it can never leak across a same-tab login (logging out of account A and into
// account B re-resolves instead of returning A's workspace). All reads are scoped
// to this; inserts default to it in the DB.
let _wsCache: string | null | undefined;
let _wsCacheUser: string | null | undefined;
export function clearWorkspaceCache() {
  _wsCache = undefined;
  _wsCacheUser = undefined;
}

// Provision a workspace for a user whose profile wasn't created by the DB trigger
// (or who was invited to a clinic). Server-side, via the service role.
async function bootstrapWorkspace(): Promise<string | null> {
  try {
    const { data: s } = await supabase.auth.getSession();
    const token = s.session?.access_token;
    if (!token) return null;
    const res = await fetch("/api/auth/bootstrap", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    const d = await res.json().catch(() => ({}));
    return d?.workspaceId ?? null;
  } catch {
    return null;
  }
}

export async function getWorkspaceId(): Promise<string | null> {
  // Read the current user id from the local session (fast, no network round-trip).
  const { data: s } = await supabase.auth.getSession();
  const uid = s.session?.user?.id ?? null;
  // Reuse the cache ONLY if it belongs to the same signed-in user.
  if (_wsCache !== undefined && _wsCacheUser === uid) return _wsCache;
  if (!uid) { _wsCache = null; _wsCacheUser = null; return null; }
  try {
    const { data } = await supabase.from("profiles").select("workspace_id").eq("user_id", uid).maybeSingle();
    let ws = data?.workspace_id ?? null;
    // Always run bootstrap once per session: it provisions a workspace when one
    // is missing AND self-heals legacy accounts that were left sharing another
    // user's workspace (they get detached into their own fresh workspace).
    const healed = await bootstrapWorkspace();
    if (healed) ws = healed;
    _wsCache = ws;
    _wsCacheUser = uid;
    return ws;
  } catch {
    _wsCache = null;
    _wsCacheUser = uid;
    return null;
  }
}

// Some networks leave a failed connection hanging instead of rejecting —
// race every primary query against a timeout so the demo fallback engages.
function withTimeout<T>(p: PromiseLike<T>, ms = 6000): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("db timeout")), ms)),
  ]);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
// Resilient upsert that does NOT rely on ON CONFLICT (which 42P10's if the matching
// unique index/constraint isn't present). Matches on `match`, updates if found else inserts.
async function upsertRow(table: string, match: Record<string, any>, row: Record<string, any>): Promise<{ error: any }> {
  let sel = supabase.from(table).select(Object.keys(match)[0]);
  for (const [k, v] of Object.entries(match)) sel = sel.eq(k, v);
  const { data: existing } = await sel.limit(1).maybeSingle();
  if (existing) {
    let upd = supabase.from(table).update(row);
    for (const [k, v] of Object.entries(match)) upd = upd.eq(k, v);
    return await upd;
  }
  return await supabase.from(table).insert({ ...match, ...row });
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToPatient(r: any): Patient {
  return {
    id: r.id,
    patNum: r.pat_num ?? 0,
    name: r.name,
    phone: r.phone ?? "",
    email: r.email ?? "",
    birthdate: r.birthdate ?? "",
    balance: Number(r.balance ?? 0),
    insurance: r.insurance ?? "Self-pay",
    lastVisit: r.last_visit ?? "—",
    nextAppointment: r.next_appointment ? r.next_appointment.slice(0, 16).replace("T", " ") : null,
    recallDue: !!r.recall_due,
    status: r.status,
    sourceChannel: r.source_channel ?? null,
    sourceAgent: r.source_agent ?? null,
  };
}

function rowToAppointment(r: any, patientName: string): Appointment {
  return {
    id: r.id,
    aptNum: r.apt_num ?? 0,
    patientId: r.patient_id,
    patientName,
    provider: r.provider ?? "",
    operatory: r.operatory ?? "",
    procedure: r.procedure ?? "",
    date: r.date,
    time: r.time ?? "",
    durationMin: r.duration_min ?? 60,
    status: r.status,
    confirmedVia: r.confirmed_via ?? null,
    fee: r.fee != null ? Number(r.fee) : null,
    source: r.source ?? r.confirmed_via ?? null,
    bookedBy: r.booked_by ?? null,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchPatients(): Promise<{ patients: Patient[]; source: DataSource }> {
  try {
    const ws = await getWorkspaceId();
    const { data, error } = await withTimeout(supabase.from("patients").select("*").eq("workspace_id", ws).order("name"));
    if (error || !data) throw error ?? new Error("no data");
    return { patients: data.map(rowToPatient), source: "live" };
  } catch {
    return { patients: [], source: "live" };
  }
}

export async function fetchAppointments(): Promise<{ appointments: Appointment[]; source: DataSource }> {
  try {
    const ws = await getWorkspaceId();
    const { data, error } = await withTimeout(
      supabase.from("appointments").select("*, patients(name)").eq("workspace_id", ws).order("date")
    );
    if (error || !data) throw error ?? new Error("no data");
    return {
      appointments: data.map((r) => rowToAppointment(r, r.patients?.name ?? "Unknown")),
      source: "live",
    };
  } catch {
    return { appointments: [], source: "live" };
  }
}

export interface PatientBundle {
  patient: Patient;
  appointments: Appointment[];
  plans: TreatmentPlan[];
  documents: PatientDocument[];
  insurance: InsurancePolicy[];
  payments: Payment[];
  source: DataSource;
}

export async function fetchPatientBundle(id: string): Promise<PatientBundle | null> {
  try {
    const ws = await getWorkspaceId();
    const { data: p, error } = await withTimeout(supabase.from("patients").select("*").eq("id", id).eq("workspace_id", ws).single());
    if (error || !p) throw error ?? new Error("not found");

    const [apts, plans, docs, ins, pays] = await Promise.all([
      supabase.from("appointments").select("*").eq("patient_id", id).order("date"),
      supabase.from("treatment_plans").select("*, treatment_procedures(*)").eq("patient_id", id),
      supabase.from("documents").select("*").eq("patient_id", id).order("uploaded_at", { ascending: false }),
      supabase.from("insurance_policies").select("*").eq("patient_id", id),
      supabase.from("payments").select("*").eq("patient_id", id).order("date", { ascending: false }),
    ]);

    const patient = rowToPatient(p);
    return {
      patient,
      appointments: (apts.data ?? []).map((r) => rowToAppointment(r, patient.name)),
      plans: (plans.data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        name: r.name,
        presentedOn: r.presented_on ?? "",
        status: r.status,
        procedures: (r.treatment_procedures ?? []).map(
          (proc: { code: string; description: string; tooth: string; fee: number; status: "Planned" | "Accepted" | "Completed" }) => ({
            code: proc.code,
            description: proc.description,
            tooth: proc.tooth ?? "",
            fee: Number(proc.fee),
            status: proc.status,
          })
        ),
      })),
      documents: (docs.data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        name: r.name,
        category: r.category,
        uploadedAt: (r.uploaded_at ?? "").slice(0, 10),
        size: r.size_label ?? "",
      })),
      insurance: (ins.data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        carrier: r.carrier,
        plan: r.plan,
        memberId: r.member_id,
        groupNumber: r.group_number,
        annualMax: Number(r.annual_max),
        usedBenefits: Number(r.used_benefits),
        deductible: Number(r.deductible),
        status: r.status,
      })),
      payments: (pays.data ?? []).map((r) => ({
        id: r.id,
        patientId: r.patient_id,
        date: r.date,
        amount: Number(r.amount),
        method: r.method,
        description: r.description ?? "",
        status: r.status,
      })),
      source: "live",
    };
  } catch {
    return null;
  }
}

export async function createPatient(input: {
  name: string;
  phone: string;
  email: string;
  birthdate: string;
  insurance: string;
  status: string;
  sourceChannel?: string;
  sourceAgent?: string;
  preferredChannel?: string;
}): Promise<{ ok: boolean; message: string }> {
  const row: Record<string, unknown> = {
    name: input.name,
    phone: input.phone,
    email: input.email,
    birthdate: input.birthdate || null,
    insurance: input.insurance || "Self-pay",
    status: input.status,
  };
  if (input.sourceChannel) row.source_channel = input.sourceChannel;
  if (input.sourceAgent) row.source_agent = input.sourceAgent;
  if (input.preferredChannel) row.preferred_channel = input.preferredChannel.toLowerCase();
  let { error } = await supabase.from("patients").insert(row);
  if (error && /source_channel|source_agent/.test(error.message)) {
    delete row.source_channel;
    delete row.source_agent;
    ({ error } = await supabase.from("patients").insert(row));
  }
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Patient created and saved to the database." };
}

// Delete contacts/patients by id (used by the Contacts bulk-delete action).
export async function deletePatients(ids: string[]): Promise<{ ok: boolean; message: string }> {
  if (ids.length === 0) return { ok: true, message: "Nothing to delete." };
  const { error } = await supabase.from("patients").delete().in("id", ids);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: `Deleted ${ids.length} contact${ids.length === 1 ? "" : "s"}.` };
}

// Edit a contact's core fields.
export async function updatePatient(id: string, patch: { name?: string; phone?: string; email?: string; status?: string; insurance?: string; birthdate?: string }): Promise<{ ok: boolean; message: string }> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.phone !== undefined) row.phone = patch.phone;
  if (patch.email !== undefined) row.email = patch.email;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.insurance !== undefined) row.insurance = patch.insurance;
  if (patch.birthdate !== undefined) row.birthdate = patch.birthdate || null;
  const { error } = await supabase.from("patients").update(row).eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Contact updated." };
}

// Bulk-insert contacts from a CSV import. Rows that fail individually are counted.
export async function importPatients(rows: { name: string; phone?: string; email?: string; status?: string; folderId?: string | null }[]): Promise<{ ok: boolean; inserted: number; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, inserted: 0, message: "Sign in first." };
  const clean = rows.filter((r) => (r.name || "").trim());
  if (clean.length === 0) return { ok: false, inserted: 0, message: "No valid rows found (need at least a name)." };
  const payload = clean.map((r) => ({
    workspace_id: ws, name: r.name.trim(), phone: (r.phone || "").trim(), email: (r.email || "").trim(),
    insurance: "Self-pay", status: r.status || "New", folder_id: r.folderId ?? null,
  }));
  const { data, error } = await supabase.from("patients").insert(payload).select("id");
  if (error) return { ok: false, inserted: 0, message: error.message };
  return { ok: true, inserted: data?.length ?? clean.length, message: `Imported ${data?.length ?? clean.length} contact(s).` };
}

// Move several contacts into a folder/list at once (used for campaign lists).
export async function setPatientsFolder(ids: string[], folderId: string | null): Promise<{ ok: boolean; message: string }> {
  if (ids.length === 0) return { ok: true, message: "Nothing to move." };
  const { error } = await supabase.from("patients").update({ folder_id: folderId }).in("id", ids);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: `Updated ${ids.length} contact${ids.length === 1 ? "" : "s"}.` };
}

export async function createAppointment(input: {
  patientId: string;
  provider: string;
  operatory: string;
  procedure: string;
  date: string;
  time: string;
}): Promise<{ ok: boolean; message: string }> {
  // workspace_id is REQUIRED — fetchAppointments filters by it, so a row
  // inserted without it never appears on the Calendar.
  const ws = await getWorkspaceId();
  const { error } = await supabase.from("appointments").insert({
    workspace_id: ws,
    patient_id: input.patientId,
    provider: input.provider,
    operatory: input.operatory,
    procedure: input.procedure || "Prophylaxis + exam",
    date: input.date,
    time: input.time,
    status: "Scheduled",
    confirmed_via: "manual",
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Appointment saved to the schedule." };
}

// Confirm / reschedule / change an appointment.
export async function updateAppointment(id: string, patch: { date?: string; time?: string; status?: string; provider?: string; operatory?: string }): Promise<{ ok: boolean; message: string }> {
  const row: Record<string, unknown> = {};
  if (patch.date !== undefined) row.date = patch.date;
  if (patch.time !== undefined) row.time = patch.time;
  if (patch.status !== undefined) row.status = patch.status;
  if (patch.provider !== undefined) row.provider = patch.provider;
  if (patch.operatory !== undefined) row.operatory = patch.operatory;
  const { error } = await supabase.from("appointments").update(row).eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Appointment updated." };
}

// Cancel an appointment (keeps the row for history, marks it Cancelled).
export async function cancelAppointment(id: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("appointments").update({ status: "Cancelled" }).eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Appointment cancelled." };
}

// A booking from a lead/agent: capture only name/email/phone + service, drop it on
// our Calendar, and (when Open Dental is enabled) forward it to the clinic so it's
// booked there too. Re-uses an existing lead with the same phone/email if present.
export async function createBooking(input: {
  name: string;
  email?: string;
  phone?: string;
  service: string;
  date: string;
  time: string;
  provider?: string;
  operatory?: string;
  fee?: number | null;
}): Promise<{ ok: boolean; message: string; openDental?: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };

  // Find an existing lead/patient by phone, then email; otherwise create one.
  let patientId: string | null = null;
  if (input.phone) {
    const { data } = await supabase.from("patients").select("id").eq("workspace_id", ws).eq("phone", input.phone).maybeSingle();
    patientId = data?.id ?? null;
  }
  if (!patientId && input.email) {
    const { data } = await supabase.from("patients").select("id").eq("workspace_id", ws).eq("email", input.email).maybeSingle();
    patientId = data?.id ?? null;
  }
  if (!patientId) {
    const { data, error } = await supabase
      .from("patients")
      .insert({ name: input.name, phone: input.phone ?? "", email: input.email ?? "", insurance: "Self-pay", status: "New" })
      .select("id")
      .single();
    if (error || !data) return { ok: false, message: error?.message ?? "Could not save the lead." };
    patientId = data.id;
  }

  const apptRow: Record<string, unknown> = {
    patient_id: patientId,
    procedure: input.service || "Consultation",
    date: input.date,
    time: input.time,
    provider: input.provider ?? "",
    operatory: input.operatory ?? "",
    status: "Scheduled",
    fee: input.fee ?? null,
    source: "manual",
    booked_by: "Staff",
  };
  let { error: aerr } = await supabase.from("appointments").insert(apptRow);
  if (aerr && /fee|source|booked_by/.test(aerr.message)) {
    delete apptRow.fee;
    delete apptRow.source;
    delete apptRow.booked_by;
    ({ error: aerr } = await supabase.from("appointments").insert(apptRow));
  }
  if (aerr) return { ok: false, message: aerr.message };

  // Best-effort: also book in Open Dental when the clinic has it enabled.
  let openDental: string | undefined;
  try {
    const cfg = await fetchOpenDentalConfig();
    if (cfg.enabled && cfg.clinicApiUrl) {
      const res = await fetch("/api/opendental/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId: ws,
          name: input.name,
          phone: input.phone ?? "",
          email: input.email ?? "",
          doctorId: input.provider || "default",
          serviceId: input.service,
          datetime: `${input.date}T${input.time}`,
          consent: true,
        }),
      });
      openDental = res.ok ? "Also booked in Open Dental." : "Saved here; Open Dental did not confirm.";
    }
  } catch {
    openDental = "Saved here; Open Dental could not be reached.";
  }

  return { ok: true, message: "Booked — added to the calendar.", openDental };
}

// ----------------------------------------------------------------- agents

// One extracted field the agent should pull out of every finished call.
export interface ExtractionField {
  name: string;
  description: string;
  type: "string" | "number" | "boolean";
}

// Advanced Vapi/Callab-style voice-call tuning. Stored as one JSONB blob on the
// agent (column `voice_settings`) so new knobs don't need schema changes. The
// field set + ranges + defaults mirror Callab's "Advanced Settings" panel.
export interface VoiceSettings {
  // Agent Speaking — Voice Activity Detection (VAD)
  minSpeechDuration: number;       // 0.1–3s · min speech to be detected (default 0.1)
  minSilenceDuration: number;      // 0.1–3s · min silence to be detected (default 0.3)
  activationThreshold: number;     // 0.1–0.9 · voice-detection sensitivity (default 0.5)
  prefixPaddingDuration: number;   // 0.1–3s · audio captured before detected speech (default 0.2)
  endOfSpeechTimeout: number;      // 0–3s · wait after speech stops before it's "finished" (default 0.2)
  // Turn Detection
  turnDetectionEnabled: boolean;   // default true
  detectionMode: "smart" | "fixed";// "smart" = AI-driven (default), "fixed" = timeout only
  detectionTimeout: number;        // 0–5s · max wait for user before agent takes turn (default 2.0)
  // Transcriber (Vapi engine)
  transcriber: "nova-2" | "nova-3"; // Deepgram model for English calls (default nova-2)
  // Noise Reduction
  noiseReductionEnabled: boolean;  // default false
  reductionLevel: "low" | "medium" | "high"; // default medium
  // Answering Machine Detection
  amdEnabled: boolean;             // default false
  multilingualAmd: boolean;        // default false
  amdTimeout: number;              // 5–30s · max wait for AMD detection (default 10)
  // Reminder & Call Duration Settings
  silenceBeforeCheck: number;      // seconds · silence before the agent checks on the caller (default 60)
  maxCheckAttempts: number;        // times the agent checks before ending the call (default 3)
  maxSilenceDuration: number;      // seconds · max silence before ending the call (default 120)
  maxCallDuration: number;         // minutes · 1–60 · max call length (default 60)
  // Privacy
  dataStorage: "store_analyze" | "store_only" | "no_store"; // default store_analyze
  // Call transfer to a human
  transferNumber: string;   // E.164 number to transfer to (empty = no transfer)
  transferMessage: string;  // what the agent says before transferring
  // Post-Call Data Extraction
  extractionFields: ExtractionField[];
}

export function defaultVoiceSettings(): VoiceSettings {
  return {
    minSpeechDuration: 0.1,
    minSilenceDuration: 0.3,
    activationThreshold: 0.5,
    prefixPaddingDuration: 0.2,
    endOfSpeechTimeout: 0.2,
    turnDetectionEnabled: true,
    detectionMode: "smart",
    transcriber: "nova-2",
    detectionTimeout: 2.0,
    noiseReductionEnabled: false,
    reductionLevel: "medium",
    amdEnabled: false,
    multilingualAmd: false,
    amdTimeout: 10,
    silenceBeforeCheck: 60,
    maxCheckAttempts: 3,
    maxSilenceDuration: 120,
    maxCallDuration: 60,
    dataStorage: "store_analyze",
    transferNumber: "",
    transferMessage: "",
    extractionFields: [],
  };
}

export interface AiAgent {
  id: string;
  name: string;
  kind: "chat" | "voice";
  role: "Receptionist" | "Sales" | "Knowledge base" | "Appointment setter" | "Follow-up";
  status: "Live" | "Paused" | "Draft";
  model: string;
  vapiAssistantId: string | null;
  voice: string;
  voiceId: string | null;
  firstMessage: string;
  language: string;
  agentIdentity: string; // Callab "Agent Identity" — who the agent is, tone, role
  instructions: string; // Callab "Tasks" — what the agent does
  behavior: string; // Callab "Style Guardrails" — phrases to use/avoid, flow
  knowledgeBase: string;
  canBook: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  channels: string[];
  purpose: "inbound" | "outbound" | "both";
  firstMessageMode: "assistant_first" | "user_first" | "assistant_first_generated";
  kbFiles: string[];
  voiceSettings: VoiceSettings;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToAgent(r: any): AiAgent {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    role: r.role,
    status: r.status,
    model: r.model ?? "openai/gpt-4o-mini",
    vapiAssistantId: r.vapi_assistant_id ?? null,
    voice: r.voice ?? "",
    voiceId: r.voice_id ?? null,
    firstMessage: r.first_message ?? "",
    language: r.language ?? "English",
    agentIdentity: r.agent_identity ?? "",
    instructions: r.instructions ?? "",
    behavior: r.behavior ?? "",
    knowledgeBase: r.knowledge_base ?? "",
    canBook: !!r.can_book,
    canReschedule: !!r.can_reschedule,
    canCancel: !!r.can_cancel,
    channels: r.channels ?? [],
    purpose: r.purpose ?? "both",
    firstMessageMode: r.first_message_mode ?? "assistant_first",
    kbFiles: r.kb_files ?? [],
    voiceSettings: { ...defaultVoiceSettings(), ...(r.voice_settings ?? {}) },
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function agentToRow(input: Omit<AiAgent, "id" | "vapiAssistantId">): Record<string, any> {
  return {
    name: input.name,
    kind: input.kind,
    role: input.role,
    status: input.status,
    model: input.model,
    voice: input.kind === "voice" ? input.voice : null,
    voice_id: input.kind === "voice" ? input.voiceId : null,
    first_message: input.firstMessage,
    language: input.language,
    agent_identity: input.agentIdentity,
    instructions: input.instructions,
    behavior: input.behavior,
    knowledge_base: input.knowledgeBase,
    can_book: input.canBook,
    can_reschedule: input.canReschedule,
    can_cancel: input.canCancel,
    channels: input.channels,
    purpose: input.purpose,
    first_message_mode: input.firstMessageMode,
    kb_files: input.kbFiles,
    voice_settings: input.kind === "voice" ? input.voiceSettings : {},
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchAgents(): Promise<{ agents: AiAgent[]; source: DataSource }> {
  try {
    const ws = await getWorkspaceId();
    const { data, error } = await withTimeout(supabase.from("agents").select("*").eq("workspace_id", ws).order("created_at"));
    if (error || !data) throw error ?? new Error("no data");
    return { agents: data.map(rowToAgent), source: "live" };
  } catch {
    return { agents: [], source: "demo" };
  }
}

export async function createAgent(input: Omit<AiAgent, "id" | "vapiAssistantId">): Promise<{ ok: boolean; message: string; id?: string }> {
  const row = agentToRow(input);
  let { data, error } = await supabase.from("agents").insert(row).select("id").single();
  if (error && /purpose|first_message_mode|kb_files|behavior|voice_id|voice_settings|agent_identity/.test(error.message)) {
    // Newer columns not migrated yet — retry without them.
    delete row.purpose;
    delete row.first_message_mode;
    delete row.kb_files;
    delete row.behavior;
    delete row.agent_identity;
    delete row.voice_id;
    delete row.voice_settings;
    ({data, error } = await supabase.from("agents").insert(row).select("id").single());
  }
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Agent saved to the database.", id: data?.id };
}

export async function setAgentVapiId(id: string, vapiId: string): Promise<void> {
  await supabase.from("agents").update({ vapi_assistant_id: vapiId }).eq("id", id);
}

export async function deleteAgent(id: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("agents").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Agent deleted." };
}

export async function updateAgent(id: string, input: Omit<AiAgent, "id" | "vapiAssistantId">): Promise<{ ok: boolean; message: string }> {
  const row = agentToRow(input);
  let { error } = await supabase.from("agents").update(row).eq("id", id);
  if (error && /purpose|first_message_mode|kb_files|behavior|voice_id|voice_settings|agent_identity/.test(error.message)) {
    delete row.purpose;
    delete row.first_message_mode;
    delete row.kb_files;
    delete row.behavior;
    delete row.agent_identity;
    delete row.voice_id;
    delete row.voice_settings;
    ({error } = await supabase.from("agents").update(row).eq("id", id));
  }
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Agent updated." };
}

// ------------------------------------------------------------ Nova (outbound sales closer)
// Nova is the clinic's OUTBOUND agent and closer — same brain, two bodies: a
// voice Nova (places calls via Vapi) and a chat Nova (WhatsApp/SMS). It sells the
// outcome, closes the booking, and never hands the patient off to a human.
// ensureNovaAgents seeds both and upgrades any older "Phoenix" build in place
// (renaming it and applying the sales config) while keeping its knowledge base.
const NOVA_NAME = "Nova";

// Revision tag embedded in Nova's instructions. Bump this whenever the config
// below changes and ensureNovaAgents() will re-apply the new config to any
// existing "Nova" agent (while keeping its uploaded knowledge base and files).
const NOVA_REV = "2026-07d";
const NOVA_REV_TAG = `rev ${NOVA_REV}`;

// ---- Shared closer brain (used by both the voice and chat Nova) -------------
const NOVA_CORE_IDENTITY =
  "You are Nova, the clinic's senior treatment advisor and lead closer. You are warm, confident, emotionally intelligent and genuinely helpful — the kind of advisor a nervous patient instantly trusts and a busy patient respects for getting to the point. You blend the reassurance of a great front-desk coordinator with the persuasion of a top sales closer. Your job is to understand what the patient really needs, show them exactly how this clinic solves it better than anyone else, remove every worry (pain, price, time, trust), and get them booked into a real appointment. " +
  "You OWN every conversation from the first hello to a confirmed booking. You are never a switchboard: you do NOT pass people to 'a human', 'the team', 'reception', 'a manager' or 'another assistant' — you ARE the person who helps them, start to finish. You represent the clinic with pride, you know its doctors and services cold (from the knowledge base), and you treat every conversation as a patient who is one good chat away from booking.";

// ---- Voice-specific identity, instructions, behavior ------------------------
const NOVA_VOICE_IDENTITY =
  NOVA_CORE_IDENTITY +
  "\n\nYou are speaking OUT LOUD on a live phone call. The person can hear your tone, your pauses and your warmth — use them. You sound like a real, likeable human being from the clinic, never like a recording or an IVR menu. You are calling to help this specific person, and everything you say should feel personal, unhurried and on their side.";

const NOVA_VOICE_INSTRUCTIONS =
  `[Nova voice playbook · ${NOVA_REV_TAG}]\n` +
  "You are an outbound voice sales closer on a live phone call. Run this flow every call:\n" +
  "1) OPEN & GET PERMISSION — greet warmly, say who you are and the clinic, and in one sentence say why you're calling. Ask if now is a good moment. If they're driving/busy, offer a better time and a quick text — never bulldoze.\n" +
  "2) DISCOVER THE REAL NEED — ask ONE open question and then LISTEN. Let them finish; never talk over them. Reflect back what you heard so they feel understood ('so the sensitivity is worst with cold drinks — got it').\n" +
  "3) SELL THE OUTCOME — describe the service in terms of the result THEY care about (comfort, a confident smile, no more pain, saving money long-term). Be specific and vivid but honest, and only use facts from the knowledge base (doctors, treatments, prices, hours, offers). You are the best salesperson in the room: confident, reassuring, never pushy.\n" +
  "4) HANDLE OBJECTIONS AS VALUE — price, fear of pain, time, 'let me think about it': acknowledge the feeling first, then reframe it into a reason to book now (payment options, gentle/sedation options, quick visits, limited slots or an offer). Never get defensive and never dismiss a worry.\n" +
  "5) ASSUME THE SALE & CLOSE — once there's interest, move to book. Offer two concrete time choices ('I've got Tuesday at 4, or Thursday morning — which suits you?') rather than asking whether they want to book.\n" +
  "6) COLLECT DETAILS ONE AT A TIME — near the end, once the value is built, gather the booking details as separate, simple questions in this order: first their full name; then their email (repeat it back letter-by-letter to confirm the spelling); then their best phone number (repeat it back digit-by-digit); then confirm the service and the day/time. One question, wait for the answer, then the next — never pile several questions into one breath.\n" +
  "7) SUMMARY & REVIEW — before booking anything, read back ONE clear summary: 'Let me make sure I have everything right — your name is [name], email [email], phone [phone], and you'd like [service] on [day] at [time]. Is all of that correct?' If they correct something, fix it and briefly re-confirm. Do NOT book until they clearly say yes.\n" +
  "8) BOOK & CONFIRM — only after they confirm the summary, call the booking tool to actually reserve the slot, then confirm out loud: service, date, time, that it's on the calendar, and that a confirmation will be sent. End warmly.\n" +
  "You NEVER say 'let me transfer you', 'let me connect you to a human', 'someone from the team will call you' or 'another assistant can help'. You handle it all. If they truly can't commit now, offer to pencil in a slot and follow up, and get their preferred callback time.";

const NOVA_VOICE_BEHAVIOR =
  "STYLE (voice) — TALK LIKE A HUMAN, NOT A SCRIPT: Speak the way a real person talks on the phone — short, natural, everyday words. HARD RULE: one sentence per turn, two at most (roughly 8–20 words), then STOP and let them talk. Say one thing at a time; never monologue, never read a paragraph, never list more than two options in one breath. It's a back-and-forth conversation, not a presentation — if you have more to say, save it for your next turn after they respond. Use plain spoken language and contractions ('I'd', 'we've', 'that's'); avoid formal or fancy words when a simple one works. Never read out markdown, bullet symbols, asterisks, emojis or URLs — say them naturally instead (say 'dot com', spell emails letter by letter). Speak numbers, prices, dates and times the way a person would ('four thirty on Tuesday', 'twelve hundred dirhams'). The ONLY exception to the short-turn rule is the booking summary read-back, which may take a few sentences. " +
  "PACING & EMPATHY: leave room for the caller to answer, don't interrupt, and if they interrupt you, stop and listen. Mirror their energy — calm and gentle with a nervous patient, brisk and efficient with a busy one. Smile through your voice. " +
  "GUARDRAILS: never invent doctors, prices, availability or medical claims — if it's not in the knowledge base, say you'll confirm and move on; never give clinical or diagnostic advice, only help them book the right consultation; stay honest and never pressure someone who has clearly said no. " +
  "Collect personal details ONE question at a time near the end (name → email → phone), reading the email and phone back to confirm, then read one full summary of everything and only book after they clearly confirm it's correct. If the line has been quiet for a few minutes and they come back, briefly welcome them back and offer to (1) carry on where you left off, (2) start fresh, or (3) just answer a quick question — then continue. Match the clinic's tone and always use only the knowledge base for facts.";

// ---- Chat-specific identity, instructions, behavior ------------------------
const NOVA_CHAT_IDENTITY =
  NOVA_CORE_IDENTITY +
  "\n\nYou are chatting by TEXT (WhatsApp / SMS / web chat). The patient reads your messages, so they must be short, skimmable and easy to reply to on a phone. You still sound like a real, warm human from the clinic — not a bot, not a form. Every message should move the conversation one clear step closer to a booking.";

const NOVA_CHAT_INSTRUCTIONS =
  `[Nova chat playbook · ${NOVA_REV_TAG}]\n` +
  "You are an outbound text/chat sales closer. Run this flow in every conversation:\n" +
  "1) OPEN WARMLY — a friendly, human first message that says who you are and why you're reaching out, ending in ONE easy question. Never open with a wall of text.\n" +
  "2) DISCOVER THE NEED — ask one simple question at a time to find what's really bothering them or what they want (pain, a gap, whitening, straightening, a check-up). Acknowledge their answer before moving on.\n" +
  "3) SELL THE OUTCOME — reply with the benefit to THEM: how the treatment fixes their problem, the comfort, the result, the value. Be specific and confident, using only knowledge-base facts (doctors, services, prices, hours, offers). Keep it tight — a couple of short lines, not an essay.\n" +
  "4) TURN OBJECTIONS INTO REASONS — for price, fear, or 'I'll think about it', acknowledge it, then reframe with a genuine reason to act now (payment plans, gentle options, quick visits, a current offer or limited slots). Never argue, never guilt-trip.\n" +
  "5) ASSUME THE SALE — once they're interested, offer two specific time options and steer to booking rather than asking 'do you want to book?'.\n" +
  "6) COLLECT DETAILS ONE BY ONE — when you're ready to book (near the end, once the value is built), ask for each detail in its OWN short message, in this order: first their full name; then their email; then their phone number; then confirm the service and preferred day/time. ONE question per message — wait for each answer before asking the next. Never cram all the questions into a single message.\n" +
  "7) SUMMARY & REVIEW — once you have everything, send ONE summary message for them to review, e.g.: 'Here's a summary of the information you provided — please check it's correct:\\nName: [name]\\nEmail: [email]\\nPhone: [phone]\\nService: [service]\\nDate & time: [day, time]\\nIs everything correct?' If they correct something, update it and re-confirm. Do NOT book until they reply that it's correct (e.g. 'yes').\n" +
  "8) BOOK & CONFIRM — only after they confirm the summary, call the booking tool to reserve the slot, then send a short confirmation (service, date, time), let them know it's on the calendar and a confirmation follows.\n" +
  "You NEVER say 'let me connect you to a human / the team / reception / another assistant'. You handle everything yourself. If they hesitate, keep helping and guide them to book; if they truly can't now, offer to hold a slot and follow up.";

const NOVA_CHAT_BEHAVIOR =
  "STYLE (text): Write like a friendly human texting from the clinic — short messages (usually 1–3 short lines), easy to read on a phone, warm but never robotic and never spammy. It's fine to use light WhatsApp-style formatting and the occasional emoji for warmth, but keep it professional and never overdo it. One idea per message; don't send walls of text or long numbered lists to a patient. Ask ONE question at a time until it's time to book. " +
  "BOOKING: collect personal details one question at a time (name → email → phone, each in its own message), then send a single summary message listing everything for the patient to review — and only book after they confirm it's correct. " +
  "GUARDRAILS: never invent doctors, prices, availability or medical claims — if it's not in the knowledge base, say you'll confirm; never give clinical or diagnostic advice, just help them book the right visit; be honest and respect a clear 'no'. " +
  "If the chat has been quiet for a few minutes and the patient comes back, briefly welcome them back and offer three simple choices — (1) continue where we left off, (2) start fresh, or (3) just ask a question about a service — then carry on. Match the clinic's tone and use only the knowledge base for facts.";

function novaIdentity(kind: "voice" | "chat"): string {
  return kind === "voice" ? NOVA_VOICE_IDENTITY : NOVA_CHAT_IDENTITY;
}
function novaInstructions(kind: "voice" | "chat"): string {
  return kind === "voice" ? NOVA_VOICE_INSTRUCTIONS : NOVA_CHAT_INSTRUCTIONS;
}
function novaBehavior(kind: "voice" | "chat"): string {
  return kind === "voice" ? NOVA_VOICE_BEHAVIOR : NOVA_CHAT_BEHAVIOR;
}

function novaBase(kind: "voice" | "chat"): Omit<AiAgent, "id" | "vapiAssistantId"> {
  return {
    name: NOVA_NAME,
    kind,
    role: kind === "voice" ? "Sales" : "Sales",
    status: "Draft",
    model: kind === "voice" ? "gpt-4o-mini" : "openai/gpt-4o-mini",
    voice: kind === "voice" ? "Ara · warm friendly female" : "",
    voiceId: null,
    firstMessage: "Hi, this is Nova from the dental clinic — is now an okay time for a quick word?",
    language: "English",
    agentIdentity: novaIdentity(kind),
    instructions: novaInstructions(kind),
    behavior: novaBehavior(kind),
    knowledgeBase: "",
    canBook: true,
    canReschedule: true,
    canCancel: false,
    channels: kind === "voice" ? ["voice"] : ["whatsapp", "sms"],
    purpose: "outbound",
    firstMessageMode: "assistant_first",
    kbFiles: [],
    voiceSettings: defaultVoiceSettings(),
  };
}

// Create missing Nova bodies, upgrade any legacy "Phoenix" build in place, AND
// refresh an existing "Nova" whose config is from an older revision. In every
// upgrade we KEEP the agent's uploaded knowledge base, files and voice settings
// (so the doctors/services docs and any tuning stay) and only rewrite the
// identity / instructions / behavior. The revision tag embedded in the
// instructions is how we detect an out-of-date agent, so re-running this after a
// config bump is safe and idempotent.
export async function ensureNovaAgents(): Promise<{ ok: boolean; message: string; voice?: AiAgent; chat?: AiAgent }> {
  const { agents } = await fetchAgents();
  const changed: string[] = [];
  for (const kind of ["voice", "chat"] as const) {
    const existing = agents.find((a) => a.kind === kind && /phoenix|nova/i.test(a.name));
    if (!existing) {
      const res = await createAgent(novaBase(kind));
      if (!res.ok) return { ok: false, message: `Couldn't create the ${kind} Nova: ${res.message}` };
      changed.push(`created ${kind}`);
      continue;
    }
    const outdated = !(existing.instructions ?? "").includes(NOVA_REV_TAG);
    const misnamed = existing.name !== NOVA_NAME;
    if (misnamed || outdated) {
      // Rename (legacy Phoenix) and/or refresh to the current revision, keeping
      // the uploaded knowledge base, files and voice settings intact.
      const { id, vapiAssistantId, ...rest } = existing; // eslint-disable-line @typescript-eslint/no-unused-vars
      // A legacy opener that still introduces the agent as "Phoenix" (or an
      // empty one) gets replaced — otherwise the call literally says Phoenix.
      const staleOpener = !rest.firstMessage?.trim() || /phoenix/i.test(rest.firstMessage);
      const res = await updateAgent(id, {
        ...rest,
        name: NOVA_NAME,
        role: "Sales",
        firstMessage: staleOpener ? novaBase(kind).firstMessage : rest.firstMessage,
        agentIdentity: novaIdentity(kind),
        instructions: novaInstructions(kind),
        behavior: novaBehavior(kind),
      });
      if (res.ok) changed.push(misnamed ? `upgraded ${kind}` : `refreshed ${kind}`);
    }
  }
  const after = (await fetchAgents()).agents;
  const voice = after.find((a) => a.kind === "voice" && /nova/i.test(a.name));
  // Mirror the voice Nova into the xAI console too (best-effort, non-blocking).
  if (voice && changed.length) {
    try {
      void fetch("/api/xai/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ agentId: voice.id }) });
    } catch { /* console mirror is optional */ }
  }
  return {
    ok: true,
    message: changed.length ? `Nova ${changed.join(" + ")}.` : "Nova is ready.",
    voice,
    chat: after.find((a) => a.kind === "chat" && /nova/i.test(a.name)),
  };
}

// ----------------------------------------------- agent hub (defaults/lines)

export interface ChannelDefault {
  channel: string;
  agentId: string | null;
  enabled: boolean;
}

export async function fetchChannelDefaults(): Promise<ChannelDefault[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("channel_defaults").select("*").eq("workspace_id", ws);
    return (data ?? []).map((r) => ({ channel: r.channel, agentId: r.agent_id, enabled: r.enabled }));
  } catch {
    return [];
  }
}

export async function setChannelDefault(channel: string, agentId: string | null, enabled: boolean): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  const { error } = await upsertRow("channel_defaults", { workspace_id: ws, channel }, { agent_id: agentId, enabled, updated_at: new Date().toISOString() });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Saved." };
}

export interface PhoneLine {
  id: string;
  number: string;
  agentId: string | null;
  direction: "inbound" | "outbound" | "both";
  active: boolean;
}

export async function fetchPhoneLines(): Promise<PhoneLine[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("phone_lines").select("*").eq("workspace_id", ws).order("created_at");
    return (data ?? []).map((r) => ({ id: r.id, number: r.number, agentId: r.agent_id, direction: r.direction, active: r.active }));
  } catch {
    return [];
  }
}

export async function addPhoneLine(number: string, agentId: string | null, direction: PhoneLine["direction"]): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  const { error } = await upsertRow("phone_lines", { workspace_id: ws, number }, { agent_id: agentId, direction, active: true });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Phone line saved." };
}

export async function removePhoneLine(id: string): Promise<void> {
  await supabase.from("phone_lines").delete().eq("id", id);
}

export async function updateAgentStatus(id: string, status: AiAgent["status"]): Promise<void> {
  await supabase.from("agents").update({ status }).eq("id", id);
}

export async function assignAgent(conversationKey: string, agentId: string): Promise<void> {
  await upsertRow("agent_assignments", { conversation_key: conversationKey }, { agent_id: agentId, active: true });
}

export async function fetchAssignments(): Promise<Record<string, string>> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("agent_assignments").select("conversation_key, agent_id").eq("workspace_id", ws).eq("active", true);
    return Object.fromEntries((data ?? []).map((r) => [r.conversation_key, r.agent_id]));
  } catch {
    return {};
  }
}

export async function enrollFollowUp(dealKey: string, agentId: string, patientName: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await upsertRow("follow_ups", { deal_key: dealKey }, { agent_id: agentId, patient_name: patientName, active: true });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Enrolled in daily follow-up." };
}

export async function fetchFollowUps(): Promise<Record<string, string>> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("follow_ups").select("deal_key, agent_id").eq("workspace_id", ws).eq("active", true);
    return Object.fromEntries((data ?? []).map((r) => [r.deal_key, r.agent_id]));
  } catch {
    return {};
  }
}

// ------------------------------------------------------------ patient folders

export interface PatientFolder {
  id: string;
  name: string;
}

export async function fetchFolders(): Promise<PatientFolder[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("patient_folders").select("*").eq("workspace_id", ws).order("name");
    return (data ?? []).map((r) => ({ id: r.id, name: r.name }));
  } catch {
    return [];
  }
}

export async function createFolder(name: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("patient_folders").insert({ name });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Folder created." };
}

export async function movePatientToFolder(patientId: string, folderId: string | null): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("patients").update({ folder_id: folderId }).eq("id", patientId);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Patient moved." };
}

export async function fetchPatientFolderMap(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.from("patients").select("id, folder_id").not("folder_id", "is", null);
    return Object.fromEntries((data ?? []).map((r) => [r.id, r.folder_id]));
  } catch {
    return {};
  }
}

// --------------------------------------------------------- whatsapp templates

export interface WaTemplateButton {
  type: "url" | "phone" | "quick_reply";
  text: string;
  value: string;
}

export interface WaTemplate {
  id: string;
  name: string;
  category: "MARKETING" | "UTILITY" | "AUTHENTICATION";
  language: string;
  headerType: "none" | "text" | "image" | "video" | "document";
  headerText: string;
  body: string;
  footer: string;
  buttons: WaTemplateButton[];
  status: "Draft" | "Pending approval" | "Approved" | "Rejected";
}

export async function fetchWaTemplates(): Promise<{ templates: WaTemplate[]; source: DataSource }> {
  try {
    const ws = await getWorkspaceId();
    const { data, error } = await withTimeout(supabase.from("wa_templates").select("*").eq("workspace_id", ws).order("created_at", { ascending: false }));
    if (error || !data) throw error ?? new Error("no data");
    return {
      templates: data.map((r) => ({
        id: r.id,
        name: r.name,
        category: r.category,
        language: r.language,
        headerType: r.header_type ?? "none",
        headerText: r.header_text ?? "",
        body: r.body,
        footer: r.footer ?? "",
        buttons: r.buttons ?? [],
        status: r.status,
      })),
      source: "live",
    };
  } catch {
    return { templates: [], source: "demo" };
  }
}

export async function createWaTemplate(t: Omit<WaTemplate, "id">): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("wa_templates").insert({
    name: t.name,
    category: t.category,
    language: t.language,
    header_type: t.headerType,
    header_text: t.headerText,
    body: t.body,
    footer: t.footer,
    buttons: t.buttons,
    status: t.status,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Template saved." };
}

export async function deleteWaTemplate(id: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("wa_templates").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Template deleted." };
}

// ------------------------------------------------------------ instagram posts

export interface IgPost {
  id: string;
  caption: string;
  mediaName: string;
  mediaUrl: string;      // public URL of the uploaded/chosen media
  platforms: string[];   // e.g. ["instagram","facebook"]
  scheduledFor: string;  // YYYY-MM-DD
  time: string;
  status: "Draft" | "Scheduled" | "Publishing" | "Published" | "Failed";
}

const parsePlatforms = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(String) : String(v ?? "instagram").split(",").map((s) => s.trim()).filter(Boolean);

export async function fetchIgPosts(): Promise<IgPost[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("ig_posts").select("*").eq("workspace_id", ws).order("scheduled_for");
    return (data ?? []).map((r) => ({
      id: r.id,
      caption: r.caption,
      mediaName: r.media_name ?? "",
      mediaUrl: r.media_url ?? "",
      platforms: parsePlatforms(r.platforms),
      scheduledFor: r.scheduled_for,
      time: r.time ?? "10:00",
      status: r.status,
    }));
  } catch {
    return [];
  }
}

export async function createIgPost(p: Omit<IgPost, "id">): Promise<{ ok: boolean; message: string }> {
  const base: Record<string, unknown> = {
    caption: p.caption,
    media_name: p.mediaName,
    scheduled_for: p.scheduledFor,
    time: p.time,
    status: p.status,
  };
  const full = { ...base, media_url: p.mediaUrl, platforms: (p.platforms ?? ["instagram"]).join(",") };
  let { error } = await supabase.from("ig_posts").insert(full);
  // media_url / platforms columns may not exist yet (migration 0055 not run).
  if (error && /media_url|platforms|column/i.test(error.message)) ({ error } = await supabase.from("ig_posts").insert(base));
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Post scheduled." };
}

export async function updateIgPost(id: string, p: Partial<Omit<IgPost, "id">>): Promise<{ ok: boolean; message: string }> {
  const row: Record<string, unknown> = {};
  const optional: Record<string, unknown> = {};
  if (p.mediaUrl !== undefined) optional.media_url = p.mediaUrl;
  if (p.platforms !== undefined) optional.platforms = p.platforms.join(",");
  if (p.caption !== undefined) row.caption = p.caption;
  if (p.mediaName !== undefined) row.media_name = p.mediaName;
  if (p.scheduledFor !== undefined) row.scheduled_for = p.scheduledFor;
  if (p.time !== undefined) row.time = p.time;
  if (p.status !== undefined) row.status = p.status;
  let { error } = await supabase.from("ig_posts").update({ ...row, ...optional }).eq("id", id);
  if (error && /media_url|platforms|column/i.test(error.message)) ({ error } = await supabase.from("ig_posts").update(row).eq("id", id));
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Post updated." };
}

export async function deleteIgPost(id: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("ig_posts").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Post deleted." };
}

// --------------------------------------------------- patient chart actions

export async function addDocument(patientId: string, name: string, category: string, sizeLabel: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("documents").insert({
    patient_id: patientId,
    name,
    category,
    size_label: sizeLabel,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Document added to the chart." };
}

export async function addPayment(patientId: string, amount: number, method: string, description: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("payments").insert({
    patient_id: patientId,
    amount,
    method,
    description,
    status: "Paid",
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Payment recorded." };
}

// ------------------------------------------------------------------ workflows

export interface WorkflowNode {
  id: string;
  type: "trigger" | "message" | "condition" | "agent" | "wait" | "action" | "handoff" | "report";
  title: string;
  detail: string;
  // Structured config the runner executes (trigger event, wait duration, etc.).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config?: Record<string, any>;
}

export interface Workflow {
  id: string;
  name: string;
  channel: string;
  status: "Live" | "Paused" | "Draft";
  nodes: WorkflowNode[];
  triggeredToday: number;
}

export async function fetchWorkflows(): Promise<{ workflows: Workflow[]; source: DataSource }> {
  try {
    const ws = await getWorkspaceId();
    const { data, error } = await withTimeout(supabase.from("workflows").select("*").eq("workspace_id", ws).order("created_at"));
    if (error || !data) throw error ?? new Error("no data");
    return {
      workflows: data.map((r) => ({
        id: r.id,
        name: r.name,
        channel: r.channel,
        status: r.status,
        nodes: r.nodes ?? [],
        triggeredToday: r.triggered_today ?? 0,
      })),
      source: "live",
    };
  } catch {
    return { workflows: [], source: "demo" };
  }
}

export async function fetchWorkflow(id: string): Promise<Workflow | null> {
  try {
    const ws = await getWorkspaceId();
    const { data, error } = await supabase.from("workflows").select("*").eq("id", id).eq("workspace_id", ws).single();
    if (error || !data) return null;
    return {
      id: data.id,
      name: data.name,
      channel: data.channel,
      status: data.status,
      nodes: data.nodes ?? [],
      triggeredToday: data.triggered_today ?? 0,
    };
  } catch {
    return null;
  }
}

export async function saveWorkflow(
  w: Omit<Workflow, "id" | "triggeredToday">,
  id?: string
): Promise<{ ok: boolean; message: string; id?: string }> {
  if (id) {
    const { error } = await supabase
      .from("workflows")
      .update({ name: w.name, channel: w.channel, status: w.status, nodes: w.nodes, updated_at: new Date().toISOString() })
      .eq("id", id);
    if (error) return { ok: false, message: error.message };
    return { ok: true, message: "Workflow saved.", id };
  }
  const { data, error } = await supabase
    .from("workflows")
    .insert({ name: w.name, channel: w.channel, status: w.status, nodes: w.nodes })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Workflow created.", id: data?.id };
}

export async function deleteWorkflow(id: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("workflows").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Workflow deleted." };
}

// ---------------------------------------------- clinical chart modules (0006)

export type ToothCondition = "healthy" | "planned" | "completed" | "watch" | "missing";

export async function fetchToothMarks(patientId: string): Promise<Record<number, ToothCondition>> {
  try {
    const { data, error } = await supabase.from("tooth_chart_marks").select("tooth, condition").eq("patient_id", patientId);
    if (error || !data) return {};
    return Object.fromEntries(data.map((r) => [r.tooth, r.condition as ToothCondition]));
  } catch {
    return {};
  }
}

export async function setToothMark(patientId: string, tooth: number, condition: ToothCondition): Promise<void> {
  try {
    await upsertRow("tooth_chart_marks", { patient_id: patientId, tooth }, { condition, updated_at: new Date().toISOString() });
  } catch {
    /* demo mode — keep local state only */
  }
}

export interface LedgerAdjustment {
  id: string;
  date: string;
  description: string;
  amount: number;
}

export async function fetchLedgerAdjustments(patientId: string): Promise<LedgerAdjustment[]> {
  try {
    const { data, error } = await supabase.from("ledger_adjustments").select("*").eq("patient_id", patientId).order("date");
    if (error || !data) return [];
    return data.map((r) => ({ id: r.id, date: r.date, description: r.description ?? "", amount: Number(r.amount) }));
  } catch {
    return [];
  }
}

export async function addLedgerAdjustment(patientId: string, adj: Omit<LedgerAdjustment, "id">): Promise<{ ok: boolean; id?: string; message: string }> {
  const { data, error } = await supabase
    .from("ledger_adjustments")
    .insert({ patient_id: patientId, date: adj.date, description: adj.description, amount: adj.amount })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: data?.id, message: "Adjustment saved." };
}

export interface ClaimRecord {
  id: string;
  carrier: string;
  procedures: string;
  billed: number;
  estInsurance: number;
  status: "Draft" | "Sent" | "Received" | "Paid";
}

export async function fetchClaims(patientId: string): Promise<ClaimRecord[]> {
  try {
    const { data, error } = await supabase.from("insurance_claims").select("*").eq("patient_id", patientId).order("created_at", { ascending: false });
    if (error || !data) return [];
    return data.map((r) => ({ id: r.id, carrier: r.carrier, procedures: r.procedures ?? "", billed: Number(r.billed), estInsurance: Number(r.est_insurance), status: r.status }));
  } catch {
    return [];
  }
}

export async function createClaim(patientId: string, c: Omit<ClaimRecord, "id">): Promise<{ ok: boolean; id?: string; message: string }> {
  const { data, error } = await supabase
    .from("insurance_claims")
    .insert({ patient_id: patientId, carrier: c.carrier, procedures: c.procedures, billed: c.billed, est_insurance: c.estInsurance, status: c.status })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: data?.id, message: "Claim created." };
}

export async function updateClaimStatus(id: string, status: ClaimRecord["status"]): Promise<void> {
  try {
    await supabase.from("insurance_claims").update({ status }).eq("id", id);
  } catch {
    /* demo mode */
  }
}

export async function deleteClaim(id: string): Promise<void> {
  try { await supabase.from("insurance_claims").delete().eq("id", id); } catch { /* demo */ }
}

export async function deleteLedgerAdjustment(id: string): Promise<void> {
  try { await supabase.from("ledger_adjustments").delete().eq("id", id); } catch { /* demo */ }
}

export interface PrescriptionRecord {
  id: string;
  drug: string;
  sig: string;
  quantity: string;
  refills: number;
  date: string;
  status: "Active" | "Sent to pharmacy" | "Completed";
}

export async function fetchPrescriptions(patientId: string): Promise<PrescriptionRecord[]> {
  try {
    const { data, error } = await supabase.from("prescriptions").select("*").eq("patient_id", patientId).order("created_at", { ascending: false });
    if (error || !data) return [];
    return data.map((r) => ({ id: r.id, drug: r.drug, sig: r.sig ?? "", quantity: r.quantity ?? "", refills: r.refills ?? 0, date: r.date, status: r.status }));
  } catch {
    return [];
  }
}

export async function createPrescription(patientId: string, rx: Omit<PrescriptionRecord, "id">): Promise<{ ok: boolean; id?: string; message: string }> {
  const { data, error } = await supabase
    .from("prescriptions")
    .insert({ patient_id: patientId, drug: rx.drug, sig: rx.sig, quantity: rx.quantity, refills: rx.refills, status: rx.status, date: rx.date })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: data?.id, message: "Prescription saved." };
}

export async function deletePrescription(id: string): Promise<void> {
  try {
    await supabase.from("prescriptions").delete().eq("id", id);
  } catch {
    /* demo mode */
  }
}

// ------------------------------------------------ pipeline stage agents (0006)

export async function fetchStageAgents(): Promise<Record<string, string>> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("pipeline_stage_agents").select("stage_id, agent_id").eq("workspace_id", ws).not("agent_id", "is", null);
    return Object.fromEntries((data ?? []).map((r) => [r.stage_id, r.agent_id]));
  } catch {
    return {};
  }
}

export async function setStageAgentDb(stageId: string, agentId: string | null): Promise<void> {
  try {
    const ws = await getWorkspaceId();
    await upsertRow("pipeline_stage_agents", { workspace_id: ws, stage_id: stageId }, { agent_id: agentId, updated_at: new Date().toISOString() });
  } catch {
    /* demo mode */
  }
}

// ------------------------------------------------ whatsapp connection (0007)

export interface WhatsappConfig {
  displayNumber: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  verifyToken: string;
  pin: string;
  connected: boolean;
  pageId: string;
  pageAccessToken: string;
  igId: string;
}

export const emptyWhatsappConfig: WhatsappConfig = {
  displayNumber: "",
  phoneNumberId: "",
  wabaId: "",
  accessToken: "",
  verifyToken: "",
  pin: "",
  connected: false,
  pageId: "",
  pageAccessToken: "",
  igId: "",
};

export async function fetchWhatsappConfig(): Promise<WhatsappConfig> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("whatsapp_config").select("*").eq("workspace", ws ?? "default").maybeSingle();
    if (!data) return emptyWhatsappConfig;
    return {
      displayNumber: data.display_number ?? "",
      phoneNumberId: data.phone_number_id ?? "",
      wabaId: data.waba_id ?? "",
      accessToken: data.access_token ?? "",
      verifyToken: data.verify_token ?? "",
      pin: data.pin ?? "",
      connected: !!data.connected,
      pageId: data.page_id ?? "",
      pageAccessToken: data.page_access_token ?? "",
      igId: data.ig_id ?? "",
    };
  } catch {
    return emptyWhatsappConfig;
  }
}

export async function saveWhatsappConfig(c: WhatsappConfig): Promise<{ ok: boolean; message: string }> {
  // "Connected" means the essential routing credentials are present.
  const connected = !!(c.phoneNumberId && c.accessToken && c.verifyToken);
  const ws = await getWorkspaceId();
  const key = ws ?? "default";
  const row = {
    display_number: c.displayNumber,
    phone_number_id: c.phoneNumberId,
    waba_id: c.wabaId,
    access_token: c.accessToken,
    verify_token: c.verifyToken,
    pin: c.pin,
    connected,
    page_id: c.pageId,
    page_access_token: c.pageAccessToken,
    ig_id: c.igId,
    updated_at: new Date().toISOString(),
  };
  // Update-or-insert (no ON CONFLICT dependency).
  const { data: existing } = await supabase.from("whatsapp_config").select("workspace").eq("workspace", key).maybeSingle();
  const { error } = existing
    ? await supabase.from("whatsapp_config").update(row).eq("workspace", key)
    : await supabase.from("whatsapp_config").insert({ workspace: key, ...row });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: connected ? "WhatsApp connected." : "Saved. Add the Phone Number ID, Access Token and Verify Token to connect." };
}

// ---------------------------------------------------- live whatsapp inbox (0008)

export interface WaConversation {
  id: string;
  contactPhone: string;
  contactName: string;
  lastMessage: string;
  lastTime: string;
  unread: number;
  assignedAgentId: string | null;
  lifecycle: string;
  status: string;
  patientId: string | null;
  channel: string;
  assignedTo: string | null;
}

export interface WaMessage {
  id: string;
  direction: "inbound" | "outbound";
  author: string;
  body: string;
  byBot: boolean;
  createdAt: string;
}

export async function fetchWaConversations(): Promise<WaConversation[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("wa_conversations").select("*").eq("workspace_id", ws).order("last_time", { ascending: false });
    return (data ?? []).map((r) => ({
      id: r.id,
      contactPhone: r.contact_phone,
      contactName: r.contact_name || r.contact_phone,
      lastMessage: r.last_message ?? "",
      lastTime: r.last_time,
      unread: r.unread ?? 0,
      assignedAgentId: r.assigned_agent_id ?? null,
      lifecycle: r.lifecycle ?? "New Lead",
      status: r.status ?? "open",
      patientId: r.patient_id ?? null,
      channel: r.channel ?? "whatsapp",
      assignedTo: r.assigned_to ?? null,
    }));
  } catch {
    return [];
  }
}

export async function setWaStatus(conversationId: string, status: string): Promise<void> {
  try {
    await supabase.from("wa_conversations").update({ status }).eq("id", conversationId);
  } catch {
    /* demo */
  }
}

// Permanently delete a conversation and its messages (from the inbox actions
// menu). Messages are removed first so no orphans remain.
export async function deleteWaConversation(conversationId: string): Promise<void> {
  try {
    await supabase.from("wa_messages").delete().eq("conversation_id", conversationId);
    await supabase.from("wa_conversations").delete().eq("id", conversationId);
  } catch {
    /* demo */
  }
}

export async function fetchWaMessages(conversationId: string): Promise<WaMessage[]> {
  try {
    const { data } = await supabase
      .from("wa_messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });
    return (data ?? []).map((r) => ({
      id: r.id,
      direction: r.direction,
      author: r.author ?? "",
      body: r.body ?? "",
      byBot: !!r.by_bot,
      createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export async function markWaRead(conversationId: string): Promise<void> {
  try {
    await supabase.from("wa_conversations").update({ unread: 0 }).eq("id", conversationId);
  } catch {
    /* demo */
  }
}

export async function assignWaAgent(conversationId: string, agentId: string | null): Promise<void> {
  try {
    await supabase.from("wa_conversations").update({ assigned_agent_id: agentId }).eq("id", conversationId);
  } catch {
    /* demo */
  }
}

export async function setWaLifecycle(conversationId: string, lifecycle: string): Promise<void> {
  try {
    await supabase.from("wa_conversations").update({ lifecycle }).eq("id", conversationId);
  } catch {
    /* demo */
  }
}

export async function sendWaReply(conversationId: string, text: string, author: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/whatsapp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId, text, author }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "send failed" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

export interface WaWebhookEvent {
  id: string;
  summary: string;
  createdAt: string;
}

export async function fetchWaWebhookEvents(): Promise<WaWebhookEvent[]> {
  try {
    const { data } = await supabase.from("wa_webhook_events").select("*").order("created_at", { ascending: false }).limit(15);
    return (data ?? []).map((r) => ({ id: r.id, summary: r.summary ?? "", createdAt: r.created_at }));
  } catch {
    return [];
  }
}

// ------------------------------------------------ whatsapp template actions (Meta)

export async function submitTemplateForApproval(templateId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/whatsapp/templates/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "submit failed" };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "submit failed" };
  }
}

export async function syncTemplateStatuses(): Promise<{ ok: boolean; updated?: number; error?: string }> {
  try {
    const res = await fetch("/api/whatsapp/templates/sync", { method: "POST" });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "sync failed" };
    return { ok: true, updated: data.updated };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "sync failed" };
  }
}

// ----------------------------------------------------------- whatsapp broadcasts

export interface WaBroadcast {
  id: string;
  name: string;
  folderName: string;
  templateName: string;
  language: string;
  status: "Draft" | "Scheduled" | "Sending" | "Sent" | "Failed";
  scheduledFor: string | null;
  sentAt: string | null;
  recipients: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
}

export async function fetchWaBroadcasts(): Promise<WaBroadcast[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("wa_broadcasts").select("*").eq("workspace_id", ws).order("created_at", { ascending: false });
    return (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      folderName: r.folder_name ?? "",
      templateName: r.template_name,
      language: r.language,
      status: r.status,
      scheduledFor: r.scheduled_for,
      sentAt: r.sent_at,
      recipients: r.recipients ?? 0,
      sent: r.sent ?? 0,
      delivered: r.delivered ?? 0,
      read: r.read ?? 0,
      failed: r.failed ?? 0,
    }));
  } catch {
    return [];
  }
}

export interface WaBroadcastRecipient {
  id: string;
  name: string;
  phone: string;
  status: string;
  error: string;
}

export async function fetchWaBroadcastRecipients(broadcastId: string): Promise<WaBroadcastRecipient[]> {
  try {
    const { data } = await supabase.from("wa_broadcast_recipients").select("*").eq("broadcast_id", broadcastId).order("created_at");
    return (data ?? []).map((r) => ({ id: r.id, name: r.name ?? "", phone: r.phone, status: r.status, error: r.error ?? "" }));
  } catch {
    return [];
  }
}

export async function createBroadcast(payload: {
  name: string;
  folderId: string | null;
  folderName: string;
  templateName: string;
  language: string;
  sendNow: boolean;
  scheduledFor: string | null;
}): Promise<{ ok: boolean; error?: string; sent?: number; failed?: number; recipients?: number; scheduled?: boolean }> {
  try {
    const workspaceId = await getWorkspaceId();
    const res = await fetch("/api/whatsapp/broadcast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...payload, workspaceId }),
    });
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data.error ?? "broadcast failed" };
    return { ok: true, sent: data.sent, failed: data.failed, recipients: data.recipients, scheduled: data.scheduled };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "broadcast failed" };
  }
}

// -------------------------------------------------------- workspace (clinic) name

// The clinic's workspace name — set at signup, editable in Settings → Profile.
export async function fetchWorkspaceName(): Promise<string> {
  try {
    const ws = await getWorkspaceId();
    if (!ws) return "";
    const { data } = await supabase.from("workspaces").select("name").eq("id", ws).maybeSingle();
    return data?.name ?? "";
  } catch {
    return "";
  }
}

// RLS only allows SELECT on workspaces for members, so the rename goes through a
// server route (service role) that verifies the caller belongs to the workspace.
export async function saveWorkspaceName(name: string): Promise<{ ok: boolean; message: string }> {
  const trimmed = name.trim();
  if (!trimmed) return { ok: true, message: "" }; // nothing to change
  try {
    const ws = await getWorkspaceId();
    if (!ws) return { ok: false, message: "Sign in first." };
    const { data: sess } = await supabase.auth.getSession();
    const token = sess.session?.access_token;
    const res = await fetch("/api/workspace/name", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ name: trimmed }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: data.error ?? "Could not rename the clinic." };
    return { ok: true, message: "Clinic name updated." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not rename the clinic." };
  }
}

// ---------------------------------------------------------- hyperfx (per-clinic)

// Each clinic can have its OWN Hyperfx account/sub-account, so its connected
// ad/SEO/calendar platforms are isolated from other clinics. Falls back to the
// global env credentials when unset (single-account mode).
export interface HyperfxConfig {
  mcpUrl: string;
  apiKey: string;
  enabled: boolean;
}

export const emptyHyperfxConfig: HyperfxConfig = { mcpUrl: "", apiKey: "", enabled: true };

export async function fetchHyperfxConfig(): Promise<HyperfxConfig> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("hyperfx_config").select("*").eq("workspace_id", ws).maybeSingle();
    if (!data) return emptyHyperfxConfig;
    return { mcpUrl: data.mcp_url ?? "", apiKey: data.api_key ?? "", enabled: data.enabled !== false };
  } catch {
    return emptyHyperfxConfig;
  }
}

export async function saveHyperfxConfig(c: HyperfxConfig): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const row = { mcp_url: c.mcpUrl.trim(), api_key: c.apiKey.trim(), enabled: c.enabled, updated_at: new Date().toISOString() };
  const { error } = await upsertRow("hyperfx_config", { workspace_id: ws }, row);
  if (error) {
    if (/hyperfx_config/.test(error.message) && /not (exist|found)|schema cache/i.test(error.message)) {
      return { ok: false, message: "Run migration 0052_hyperfx_config.sql in Supabase first, then save again." };
    }
    return { ok: false, message: error.message };
  }
  return { ok: true, message: "Hyperfx credentials saved for this clinic." };
}

// ------------------------------------------------------- open dental (gateway)

export interface OpenDentalConfig {
  clinicApiUrl: string;
  clinicApiKey: string;       // the Customer API Key (per-clinic)
  developerKey: string;       // the Developer API Key (Open Dental API uses ODFHIR Developer/Customer)
  clinicUsername: string;     // HTTP Basic auth, if the middleware provider requires it
  clinicPassword: string;
  enabled: boolean;
}

export const emptyOpenDentalConfig: OpenDentalConfig = { clinicApiUrl: "", clinicApiKey: "", developerKey: "", clinicUsername: "", clinicPassword: "", enabled: false };

export async function fetchOpenDentalConfig(): Promise<OpenDentalConfig> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("opendental_config").select("*").eq("workspace_id", ws).maybeSingle();
    if (!data) return emptyOpenDentalConfig;
    return {
      clinicApiUrl: data.clinic_api_url ?? "",
      clinicApiKey: data.clinic_api_key ?? "",
      developerKey: data.developer_key ?? "",
      clinicUsername: data.clinic_username ?? "",
      clinicPassword: data.clinic_password ?? "",
      enabled: !!data.enabled,
    };
  } catch {
    return emptyOpenDentalConfig;
  }
}

export async function saveOpenDentalConfig(c: OpenDentalConfig): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  // Normalize the middleware URL: strip trailing slashes, add https:// if the
  // scheme was left off — a missing scheme is an instant "fetch failed".
  let url = c.clinicApiUrl.trim().replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  const row: Record<string, unknown> = {
    clinic_api_url: url,
    clinic_api_key: c.clinicApiKey.trim(),
    developer_key: c.developerKey.trim(),
    clinic_username: c.clinicUsername.trim(),
    clinic_password: c.clinicPassword.trim(),
    enabled: c.enabled,
    updated_at: new Date().toISOString(),
  };
  const { data: existing } = await supabase.from("opendental_config").select("workspace_id").eq("workspace_id", ws).maybeSingle();
  const write = (r: Record<string, unknown>) =>
    existing
      ? supabase.from("opendental_config").update(r).eq("workspace_id", ws)
      : supabase.from("opendental_config").insert({ workspace_id: ws, ...r });
  let { error } = await write(row);
  // developer_key column arrives with migration 0056 — retry without it if it's missing.
  if (error && /developer_key/.test(error.message)) {
    delete row.developer_key;
    ({ error } = await write(row));
    if (!error) return { ok: true, message: "Saved — but the Developer API Key was NOT stored: run migration 0056_opendental_developer_key.sql in Supabase first, then save again." };
  }
  // Username/password columns arrive with migration 0051 — retry without them
  // so the rest still saves, and say clearly that the migration is needed.
  if (error && /clinic_username|clinic_password/.test(error.message)) {
    delete row.clinic_username;
    delete row.clinic_password;
    ({ error } = await write(row));
    if (!error) return { ok: true, message: "Saved — but the username/password were NOT stored: run migration 0051_opendental_credentials.sql in Supabase first, then save again." };
  }
  if (error) return { ok: false, message: error.message };
  // Saving only stores the settings — it does NOT prove the middleware is
  // reachable. Don't say "connected" here; that's Test connection's job.
  return { ok: true, message: c.enabled ? "Settings saved — now click Test connection to verify the clinic middleware." : "Saved." };
}

// Staged connection test (see /api/opendental/test): checks URL sanity, tunnel
// reachability (/health, no key) and API-key auth (/doctors) separately, so a
// failure says exactly which layer broke. Returns scheduling data only.
export async function odTestConnection(): Promise<{ ok: boolean; doctors?: number; mode?: string; error?: string }> {
  try {
    const ws = await getWorkspaceId();
    const res = await fetch(`/api/opendental/test?ws=${ws ?? ""}`);
    const data = await res.json();
    if (!res.ok || !data.ok) return { ok: false, mode: data.mode, error: data.error ?? "Connection failed" };
    return { ok: true, doctors: data.doctors ?? 0, mode: data.mode };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Connection failed" };
  }
}

// ----------------------------------------------------------- voice calls (Vapi)

// One turn in the structured conversation timeline (from Vapi's artifact).
export interface CallMessage {
  role: string; // bot / assistant / user / tool_calls / tool_call_result / system
  text: string;
  secondsFromStart: number | null;
  toolCalls?: { name: string; args: unknown }[];
  toolName?: string;
  toolResult?: string;
}

export interface VoiceCallRecord {
  id: string;
  agentName: string;
  callerPhone: string;
  toPhone: string;
  patientId: string | null;
  direction: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSec: number;
  endedReason: string;
  transcript: string;
  summary: string;
  recordingUrl: string;
  outcome: string;
  campaignId: string | null;
  messages: CallMessage[];
  structuredData: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function normalizeCallMessages(raw: any): CallMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m: any): CallMessage | null => {
      const role = m?.role ?? "";
      if (role === "system") return null;
      const text = typeof m?.message === "string" ? m.message : typeof m?.content === "string" ? m.content : "";
      const secs = m?.secondsFromStart != null ? Number(m.secondsFromStart) : m?.time != null ? Number(m.time) / 1000 : null;
      const out: CallMessage = { role, text, secondsFromStart: Number.isFinite(secs as number) ? (secs as number) : null };
      if (Array.isArray(m?.toolCalls) && m.toolCalls.length) {
        out.toolCalls = m.toolCalls.map((tc: any) => {
          let args = tc?.function?.arguments ?? tc?.arguments ?? {};
          if (typeof args === "string") { try { args = JSON.parse(args); } catch { /* keep string */ } }
          return { name: tc?.function?.name ?? tc?.name ?? "tool", args };
        });
      }
      if (role === "tool_call_result" || m?.result != null) {
        out.toolName = m?.name ?? "";
        out.toolResult = typeof m?.result === "string" ? m.result : m?.result != null ? JSON.stringify(m.result, null, 2) : "";
      }
      return out;
    })
    .filter((m): m is CallMessage => m != null);
}

function rowToVoiceCall(r: any): VoiceCallRecord {
  return {
    id: r.id,
    agentName: r.agent_name ?? "",
    callerPhone: r.caller_phone ?? "",
    toPhone: r.to_phone ?? "",
    patientId: r.patient_id ?? null,
    direction: r.direction ?? "inbound",
    status: r.status ?? "ended",
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    durationSec: r.duration_sec ?? 0,
    endedReason: r.ended_reason ?? "",
    transcript: r.transcript ?? "",
    summary: r.summary ?? "",
    recordingUrl: r.recording_url ?? "",
    outcome: r.outcome ?? "",
    campaignId: r.campaign_id ?? null,
    messages: normalizeCallMessages(r.messages),
    structuredData: (r.structured_data && typeof r.structured_data === "object") ? r.structured_data : {},
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchVoiceCalls(): Promise<VoiceCallRecord[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("voice_calls").select("*").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(500);
    return (data ?? []).map(rowToVoiceCall);
  } catch {
    return [];
  }
}

export async function fetchVoiceCall(id: string): Promise<VoiceCallRecord | null> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("voice_calls").select("*").eq("workspace_id", ws).eq("id", id).maybeSingle();
    return data ? rowToVoiceCall(data) : null;
  } catch {
    return null;
  }
}

// ----------------------------------------------------------- billing (0041)

export interface BillingSettings {
  planName: string;
  monthlyPrice: number;
  minutesIncluded: number;
  minutesBalance: number;
  concurrencyLimit: number;
  nextBilling: string | null;
  autoRecharge: boolean;
  rechargeBelow: number;
  rechargeTo: number;
  pricePerMinute: number;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExp: string | null;
}

export interface BillingInvoice {
  id: string;
  description: string;
  amount: number;
  status: string;
  invoiceUrl: string | null;
  paidAt: string | null;
}

function defaultBilling(): BillingSettings {
  return {
    planName: "Starter", monthlyPrice: 0, minutesIncluded: 0, minutesBalance: 0,
    concurrencyLimit: 5, nextBilling: null, autoRecharge: false, rechargeBelow: 10,
    rechargeTo: 60, pricePerMinute: 0.15, cardBrand: null, cardLast4: null, cardExp: null,
  };
}

export async function fetchBilling(): Promise<{ settings: BillingSettings; invoices: BillingInvoice[] }> {
  try {
    const ws = await getWorkspaceId();
    const [{ data: s }, { data: inv }] = await Promise.all([
      supabase.from("billing_settings").select("*").eq("workspace_id", ws).maybeSingle(),
      supabase.from("billing_invoices").select("*").eq("workspace_id", ws).order("paid_at", { ascending: false }),
    ]);
    const settings: BillingSettings = s
      ? {
          planName: s.plan_name ?? "Starter", monthlyPrice: Number(s.monthly_price ?? 0),
          minutesIncluded: s.minutes_included ?? 0, minutesBalance: Number(s.minutes_balance ?? 0),
          concurrencyLimit: s.concurrency_limit ?? 5, nextBilling: s.next_billing ?? null,
          autoRecharge: !!s.auto_recharge, rechargeBelow: s.recharge_below ?? 10, rechargeTo: s.recharge_to ?? 60,
          pricePerMinute: Number(s.price_per_minute ?? 0.15), cardBrand: s.card_brand ?? null,
          cardLast4: s.card_last4 ?? null, cardExp: s.card_exp ?? null,
        }
      : defaultBilling();
    const invoices: BillingInvoice[] = (inv ?? []).map((r) => ({
      id: r.id, description: r.description ?? "", amount: Number(r.amount ?? 0), status: r.status ?? "paid",
      invoiceUrl: r.invoice_url ?? null, paidAt: r.paid_at ?? null,
    }));
    return { settings, invoices };
  } catch {
    return { settings: defaultBilling(), invoices: [] };
  }
}

export async function saveAutoRecharge(input: { autoRecharge: boolean; rechargeBelow: number; rechargeTo: number }): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { error } = await upsertRow("billing_settings", { workspace_id: ws }, {
    auto_recharge: input.autoRecharge, recharge_below: input.rechargeBelow, recharge_to: input.rechargeTo, updated_at: new Date().toISOString(),
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Auto-recharge settings saved." };
}

// Subscription plans. Stripe is NOT required to activate a plan today — choosing
// one applies the plan and credits its included minutes right away (recorded as a
// "manual" invoice). When Stripe is connected the payment step runs first and this
// same crediting happens on the payment webhook.
export interface Plan {
  key: string;
  name: string;
  monthlyPrice: number;
  minutesIncluded: number;
  concurrencyLimit: number;
  pricePerMinute: number;
  blurb: string;
}
export const PLANS: Plan[] = [
  { key: "starter", name: "Starter", monthlyPrice: 49, minutesIncluded: 300, concurrencyLimit: 5, pricePerMinute: 0.15, blurb: "Single clinic getting started" },
  { key: "growth", name: "Growth", monthlyPrice: 149, minutesIncluded: 1200, concurrencyLimit: 15, pricePerMinute: 0.12, blurb: "Busy practice, multiple agents" },
  { key: "clinic", name: "Clinic", monthlyPrice: 399, minutesIncluded: 4000, concurrencyLimit: 40, pricePerMinute: 0.1, blurb: "High call volume / multi-site" },
];

// Manually credit calling minutes to the workspace (a "top-up"). Works WITHOUT
// Stripe: adds the minutes now and logs an invoice for the record. `charged`
// marks whether money actually moved (true once Stripe is wired in).
export async function addMinutes(qty: number, opts?: { charged?: boolean }): Promise<{ ok: boolean; message: string; balance?: number }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  if (!Number.isFinite(qty) || qty <= 0) return { ok: false, message: "Enter how many minutes to add." };
  const { data: cur } = await supabase.from("billing_settings").select("minutes_balance, minutes_included, price_per_minute").eq("workspace_id", ws).maybeSingle();
  const ppm = Number(cur?.price_per_minute ?? 0.15);
  const newBalance = Number(cur?.minutes_balance ?? 0) + qty;
  // Keep "included" at least as large as the balance so the progress bar reads sensibly.
  const included = Math.max(Number(cur?.minutes_included ?? 0), newBalance);
  const { error } = await upsertRow("billing_settings", { workspace_id: ws }, { minutes_balance: newBalance, minutes_included: included, updated_at: new Date().toISOString() });
  if (error) return { ok: false, message: error.message };
  await supabase.from("billing_invoices").insert({ workspace_id: ws, description: `${qty} calling minutes added`, amount: Number((qty * ppm).toFixed(2)), status: opts?.charged ? "paid" : "manual" });
  return {
    ok: true,
    balance: newBalance,
    message: opts?.charged ? `${qty} minutes added.` : `${qty} minutes added — no card charged yet (connect Stripe to bill automatically).`,
  };
}

// Activate/switch a plan. Credits the plan's included minutes and sets price,
// concurrency and the next billing date. No Stripe needed to try it today.
export async function changePlan(planKey: string): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const plan = PLANS.find((p) => p.key === planKey);
  if (!plan) return { ok: false, message: "Unknown plan." };
  const { data: cur } = await supabase.from("billing_settings").select("minutes_balance").eq("workspace_id", ws).maybeSingle();
  const balance = Number(cur?.minutes_balance ?? 0) + plan.minutesIncluded;
  const nextBilling = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  const { error } = await upsertRow("billing_settings", { workspace_id: ws }, {
    plan_name: plan.name, monthly_price: plan.monthlyPrice, minutes_included: Math.max(plan.minutesIncluded, balance),
    minutes_balance: balance, concurrency_limit: plan.concurrencyLimit, price_per_minute: plan.pricePerMinute,
    next_billing: nextBilling, updated_at: new Date().toISOString(),
  });
  if (error) return { ok: false, message: error.message };
  await supabase.from("billing_invoices").insert({ workspace_id: ws, description: `${plan.name} plan — ${plan.minutesIncluded} minutes`, amount: plan.monthlyPrice, status: "manual" });
  return { ok: true, message: `Switched to ${plan.name} — ${plan.minutesIncluded} minutes credited. No card charged yet (connect Stripe to bill automatically).` };
}

// ----------------------------------------------------------- campaigns (0039)

export interface Campaign {
  id: string;
  name: string;
  agentId: string | null;
  numberId: string | null;
  folderId: string | null;
  direction: "inbound" | "outbound";
  status: "active" | "paused" | "draft";
  createdAt: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToCampaign(r: any): Campaign {
  return {
    id: r.id,
    name: r.name ?? "",
    agentId: r.agent_id ?? null,
    numberId: r.number_id ?? null,
    folderId: r.folder_id ?? null,
    direction: r.direction ?? "outbound",
    status: r.status ?? "active",
    createdAt: r.created_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchCampaigns(): Promise<Campaign[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("campaigns").select("*").eq("workspace_id", ws).order("created_at", { ascending: false });
    return (data ?? []).map(rowToCampaign);
  } catch {
    return [];
  }
}

export async function createCampaign(input: Omit<Campaign, "id" | "createdAt">): Promise<{ ok: boolean; message: string; id?: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { data, error } = await supabase
    .from("campaigns")
    .insert({ workspace_id: ws, name: input.name, agent_id: input.agentId, number_id: input.numberId, folder_id: input.folderId, direction: input.direction, status: input.status })
    .select("id")
    .single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Campaign created.", id: data?.id };
}

export async function updateCampaignStatus(id: string, status: Campaign["status"]): Promise<void> {
  await supabase.from("campaigns").update({ status }).eq("id", id);
}

export async function updateCampaign(id: string, input: Partial<Omit<Campaign, "id" | "createdAt">>): Promise<{ ok: boolean; message: string }> {
  const row: Record<string, unknown> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.agentId !== undefined) row.agent_id = input.agentId;
  if (input.numberId !== undefined) row.number_id = input.numberId;
  if (input.folderId !== undefined) row.folder_id = input.folderId;
  if (input.direction !== undefined) row.direction = input.direction;
  if (input.status !== undefined) row.status = input.status;
  const { error } = await supabase.from("campaigns").update(row).eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Campaign updated." };
}

export async function deleteCampaign(id: string): Promise<void> {
  await supabase.from("campaigns").delete().eq("id", id);
}

// ----------------------------------------------------------- team members (0023)

export interface TeamMember {
  id: string;
  email: string;
  name: string;
  role: "admin" | "editor" | "viewer";
  status: "invited" | "active";
}

export async function fetchTeamMembers(): Promise<TeamMember[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("team_members").select("*").eq("workspace_id", ws).order("created_at");
    return (data ?? []).map((r) => ({ id: r.id, email: r.email, name: r.name ?? "", role: r.role, status: r.status }));
  } catch {
    return [];
  }
}

export async function inviteTeamMember(email: string, role: TeamMember["role"], name: string): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const clean = email.trim().toLowerCase();
  const { data: existing } = await supabase.from("team_members").select("id").eq("workspace_id", ws).eq("email", clean).maybeSingle();
  if (existing) return { ok: false, message: "That email is already a member." };
  const { error } = await supabase.from("team_members").insert({ workspace_id: ws, email: clean, name: name.trim(), role, status: "invited" });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: `Invited ${clean}. They join your clinic when they sign up with this email.` };
}

export async function updateTeamMember(id: string, patch: Partial<Pick<TeamMember, "role">>): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("team_members").update(patch).eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Updated." };
}

export async function removeTeamMember(id: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("team_members").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Removed." };
}

// Assign a live conversation to a person (name/email) — turns AI off — or clear it.
export async function setWaAssignee(conversationId: string, assignee: string | null): Promise<void> {
  try {
    await supabase
      .from("wa_conversations")
      .update({ assigned_to: assignee, status: assignee ? "human" : "open", assigned_agent_id: assignee ? null : undefined })
      .eq("id", conversationId);
  } catch {
    /* demo */
  }
}

// ----------------------------------------------------------- voice numbers / SIP (0034)

export interface SipCategory {
  ipOrDomain: string;
  port: string;
  protocol: "UDP" | "TCP" | "TLS";
  direction: "inbound" | "outbound";
  active: boolean;
  ping: boolean;
}

export interface VoiceNumber {
  id: string;
  number: string;
  nickname: string;
  agentId: string | null;
  direction: "inbound" | "outbound" | "both";
  provider: "vapi" | "twilio" | "sip" | "ziwo" | "goautodial" | "maqsam" | "vocalcom" | "landline";
  concurrency: number;
  // The id Vapi assigns the number once it's registered — lets us PATCH it to
  // re-route inbound to a different agent without deleting/recreating.
  vapiPhoneNumberId: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>;
  createdAt: string;
}

export async function fetchVoiceNumbers(): Promise<VoiceNumber[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("voice_numbers").select("*").eq("workspace_id", ws).order("created_at", { ascending: false });
    return (data ?? []).map((r) => ({ id: r.id, number: r.number, nickname: r.nickname ?? "", agentId: r.agent_id ?? null, direction: r.direction ?? "inbound", provider: r.provider ?? "sip", concurrency: r.concurrency ?? 1, vapiPhoneNumberId: r.vapi_phone_number_id ?? null, config: r.config ?? {}, createdAt: r.created_at }));
  } catch {
    return [];
  }
}

export async function createVoiceNumber(input: Omit<VoiceNumber, "id" | "createdAt" | "vapiPhoneNumberId">): Promise<{ ok: boolean; message: string; id?: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { data, error } = await supabase.from("voice_numbers").insert({
    workspace_id: ws, number: input.number, nickname: input.nickname, agent_id: input.agentId, direction: input.direction,
    provider: input.provider, concurrency: input.concurrency, config: input.config,
  }).select("id").single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Phone number added.", id: data?.id };
}

// Re-point an existing number to a different agent / direction, and/or store the
// Vapi phone-number id. Gracefully drops vapi_phone_number_id if the column isn't
// migrated yet so the rest of the update still lands.
export async function updateVoiceNumber(
  id: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  patch: { agentId?: string | null; direction?: VoiceNumber["direction"]; nickname?: string; number?: string; config?: Record<string, any>; vapiPhoneNumberId?: string | null }
): Promise<{ ok: boolean; message: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: Record<string, any> = {};
  if (patch.agentId !== undefined) row.agent_id = patch.agentId;
  if (patch.direction !== undefined) row.direction = patch.direction;
  if (patch.nickname !== undefined) row.nickname = patch.nickname;
  if (patch.number !== undefined) row.number = patch.number;
  if (patch.config !== undefined) row.config = patch.config;
  if (patch.vapiPhoneNumberId !== undefined) row.vapi_phone_number_id = patch.vapiPhoneNumberId;
  const { error } = await supabase.from("voice_numbers").update(row).eq("id", id);
  if (error && /vapi_phone_number_id/.test(error.message)) {
    // The column isn't migrated — save the rest, but surface that the Vapi link
    // couldn't be stored (so the number doesn't silently look "not on Vapi").
    delete row.vapi_phone_number_id;
    const retry = await supabase.from("voice_numbers").update(row).eq("id", id);
    if (retry.error) return { ok: false, message: retry.error.message };
    if (patch.vapiPhoneNumberId) return { ok: false, message: "Registered on Vapi, but couldn't save the link — run migration 0043 (vapi_phone_number_id) in Supabase." };
    return { ok: true, message: "Number updated." };
  }
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Number updated." };
}

export async function deleteVoiceNumber(id: string): Promise<void> {
  try { await supabase.from("voice_numbers").delete().eq("id", id); } catch { /* ignore */ }
}

// ----------------------------------------------------------- AI Team: autopilot (0032)

export interface ScheduledTask {
  id: string;
  agentKey: string;
  title: string;
  instruction: string;
  cadence: "daily" | "weekly" | "monthly";
  nextRun: string;
  status: "active" | "paused";
  lastRun: string | null;
  lastResult: string;
}

export async function listScheduledTasks(agentKey: string): Promise<ScheduledTask[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("scheduled_tasks").select("*").eq("workspace_id", ws).eq("agent_key", agentKey).order("created_at", { ascending: false });
    return (data ?? []).map((r) => ({ id: r.id, agentKey: r.agent_key, title: r.title ?? "", instruction: r.instruction, cadence: r.cadence, nextRun: r.next_run, status: r.status, lastRun: r.last_run ?? null, lastResult: r.last_result ?? "" }));
  } catch {
    return [];
  }
}

export async function createScheduledTask(input: { agentKey: string; title: string; instruction: string; cadence: string; firstRun: string }): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { error } = await supabase.from("scheduled_tasks").insert({ workspace_id: ws, agent_key: input.agentKey, title: input.title, instruction: input.instruction, cadence: input.cadence, next_run: input.firstRun, status: "active" });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Autopilot task scheduled." };
}

export async function setScheduledTaskStatus(id: string, status: "active" | "paused"): Promise<void> {
  try { await supabase.from("scheduled_tasks").update({ status }).eq("id", id); } catch { /* ignore */ }
}

export async function deleteScheduledTask(id: string): Promise<void> {
  try { await supabase.from("scheduled_tasks").delete().eq("id", id); } catch { /* ignore */ }
}

// ----------------------------------------------------------- AI Team: reports + activity (0031)

export interface AgentReport {
  id: string;
  agentKey: string;
  title: string;
  createdAt: string;
}

export async function fetchReports(agentKey?: string): Promise<AgentReport[]> {
  try {
    const ws = await getWorkspaceId();
    let q = supabase.from("reports").select("id, agent_key, title, created_at").eq("workspace_id", ws);
    if (agentKey) q = q.eq("agent_key", agentKey);
    const { data } = await q.order("created_at", { ascending: false }).limit(50);
    return (data ?? []).map((r) => ({ id: r.id, agentKey: r.agent_key ?? "", title: r.title ?? "Report", createdAt: r.created_at }));
  } catch {
    return [];
  }
}

export interface AgentActivity {
  id: string;
  action: string;
  detail: string;
  link: string;
  createdAt: string;
}

export async function fetchAgentActivity(agentKey: string): Promise<AgentActivity[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("agent_activity").select("*").eq("workspace_id", ws).eq("agent_key", agentKey).order("created_at", { ascending: false }).limit(40);
    return (data ?? []).map((r) => ({ id: r.id, action: r.action, detail: r.detail ?? "", link: r.link ?? "", createdAt: r.created_at }));
  } catch {
    return [];
  }
}

// ----------------------------------------------------------- AI Team: brand + chats (0030)

// A clinic's structured brand identity — everything the AI agents need to sound
// like the real clinic when they write posts, ads, emails and replies.
export interface BrandDoctor { name: string; specialty: string; experience: string; email: string }
export interface BrandDetails {
  about: string;
  services: string;
  tone: string;
  contactEmail: string;
  phone: string;
  address: string;
  website: string;
  instagram: string;
  facebook: string;
  tiktok: string;
  doctors: BrandDoctor[];
}
export const emptyBrandDetails: BrandDetails = {
  about: "", services: "", tone: "", contactEmail: "", phone: "", address: "", website: "",
  instagram: "", facebook: "", tiktok: "", doctors: [],
};

export interface BrandKnowledge {
  profile: string;
  logoUrl: string;
  colors: string;
  details?: BrandDetails;
}

// Turn the structured identity into the plain-text profile the agents read.
function composeBrandProfile(d: BrandDetails, clinicName?: string): string {
  const lines: string[] = [];
  if (clinicName) lines.push(`Clinic: ${clinicName}`);
  if (d.about) lines.push(d.about);
  if (d.services) lines.push(`Services / specialties: ${d.services}`);
  if (d.doctors?.length) {
    lines.push("Doctors:");
    for (const doc of d.doctors) {
      const bits = [doc.name, doc.specialty, doc.experience && `${doc.experience} experience`, doc.email].filter(Boolean);
      if (bits.length) lines.push(`- ${bits.join(" — ")}`);
    }
  }
  const contact = [d.contactEmail && `email ${d.contactEmail}`, d.phone && `phone ${d.phone}`, d.address, d.website].filter(Boolean).join(", ");
  if (contact) lines.push(`Contact: ${contact}`);
  const socials = [d.instagram && `Instagram ${d.instagram}`, d.facebook && `Facebook ${d.facebook}`, d.tiktok && `TikTok ${d.tiktok}`].filter(Boolean).join(", ");
  if (socials) lines.push(`Social: ${socials}`);
  if (d.tone) lines.push(`Brand voice: ${d.tone}`);
  return lines.join("\n");
}

export async function fetchBrandKnowledge(): Promise<BrandKnowledge> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("brand_knowledge").select("*").eq("workspace_id", ws).maybeSingle();
    const details = (data?.details && typeof data.details === "object") ? { ...emptyBrandDetails, ...data.details } : emptyBrandDetails;
    return { profile: data?.profile ?? "", logoUrl: data?.logo_url ?? "", colors: data?.colors ?? "", details };
  } catch {
    return { profile: "", logoUrl: "", colors: "", details: emptyBrandDetails };
  }
}

export async function saveBrandKnowledge(b: BrandKnowledge): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { data: existing } = await supabase.from("brand_knowledge").select("workspace_id").eq("workspace_id", ws).maybeSingle();
  // When structured details are provided, compose the agent-facing profile from
  // them (so what the clinic fills in the Brand Identity page is exactly what the
  // agents use). The freeform team-ai brand modal still saves profile directly.
  let profile = b.profile;
  const row: Record<string, unknown> = { logo_url: b.logoUrl, colors: b.colors, updated_at: new Date().toISOString() };
  if (b.details) {
    const clinicName = await fetchWorkspaceName().catch(() => "");
    profile = composeBrandProfile(b.details, clinicName || undefined);
    row.details = b.details;
  }
  row.profile = profile;
  const { error } = existing
    ? await supabase.from("brand_knowledge").update(row).eq("workspace_id", ws)
    : await supabase.from("brand_knowledge").insert({ workspace_id: ws, ...row });
  if (error) {
    // `details` column may not exist yet (migration 0054 not run) — retry without it.
    if (b.details && /details|column/i.test(error.message)) {
      delete row.details;
      const retry = existing
        ? await supabase.from("brand_knowledge").update(row).eq("workspace_id", ws)
        : await supabase.from("brand_knowledge").insert({ workspace_id: ws, ...row });
      if (!retry.error) return { ok: true, message: "Saved (run migration 0054 to store the full structured identity)." };
      return { ok: false, message: retry.error.message };
    }
    return { ok: false, message: error.message };
  }
  return { ok: true, message: "Brand identity saved — your agents will use it." };
}

export interface BrandDocument {
  id: string;
  name: string;
  content: string;
}

export async function fetchBrandDocuments(): Promise<BrandDocument[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("brand_documents").select("id, name, content").eq("workspace_id", ws).order("created_at", { ascending: false }).limit(100);
    return (data ?? []).map((r) => ({ id: r.id, name: r.name ?? "Document", content: r.content ?? "" }));
  } catch {
    return [];
  }
}

export async function addBrandDocument(name: string, content: string): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { error } = await supabase.from("brand_documents").insert({ workspace_id: ws, name: name.slice(0, 200), content: content.slice(0, 200000) });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Document added to brand knowledge." };
}

export async function deleteBrandDocument(id: string): Promise<void> {
  try { await supabase.from("brand_documents").delete().eq("id", id); } catch { /* ignore */ }
}

export interface TeamChat {
  id: string;
  agentKey: string;
  title: string;
  updatedAt: string;
}

export async function listTeamChats(agentKey: string): Promise<TeamChat[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("team_chats").select("id, agent_key, title, updated_at").eq("workspace_id", ws).eq("agent_key", agentKey).order("updated_at", { ascending: false }).limit(50);
    return (data ?? []).map((r) => ({ id: r.id, agentKey: r.agent_key, title: r.title ?? "Chat", updatedAt: r.updated_at }));
  } catch {
    return [];
  }
}

export async function createTeamChat(agentKey: string, title: string): Promise<string | null> {
  const ws = await getWorkspaceId();
  if (!ws) return null;
  const { data } = await supabase.from("team_chats").insert({ workspace_id: ws, agent_key: agentKey, title: title.slice(0, 80) || "New chat" }).select("id").single();
  return data?.id ?? null;
}

export async function fetchTeamChatMessages(chatId: string): Promise<{ role: "user" | "assistant"; content: string }[]> {
  try {
    const { data } = await supabase.from("team_chat_messages").select("role, content").eq("chat_id", chatId).order("created_at");
    return (data ?? []).map((r) => ({ role: r.role === "assistant" ? "assistant" : "user", content: r.content }));
  } catch {
    return [];
  }
}

export async function appendTeamChatMessage(chatId: string, role: "user" | "assistant", content: string): Promise<void> {
  try {
    await supabase.from("team_chat_messages").insert({ chat_id: chatId, role, content });
    await supabase.from("team_chats").update({ updated_at: new Date().toISOString() }).eq("id", chatId);
  } catch {
    /* ignore */
  }
}

export async function deleteTeamChat(chatId: string): Promise<void> {
  try {
    await supabase.from("team_chats").delete().eq("id", chatId);
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------- learning agent (0029)

export interface LearningQuestion {
  id: string;
  agentId: string | null;
  agentName: string;
  question: string;
  timesAsked: number;
  status: "open" | "taught";
  lastSeen: string;
}

export async function fetchLearningQuestions(): Promise<LearningQuestion[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase
      .from("learning_questions")
      .select("*")
      .eq("workspace_id", ws)
      .order("status")
      .order("times_asked", { ascending: false })
      .order("last_seen", { ascending: false });
    return (data ?? []).map((r) => ({
      id: r.id,
      agentId: r.agent_id ?? null,
      agentName: r.agent_name ?? "",
      question: r.question,
      timesAsked: r.times_asked ?? 1,
      status: r.status === "taught" ? "taught" : "open",
      lastSeen: r.last_seen ?? r.created_at,
    }));
  } catch {
    return [];
  }
}

// Teach an agent: append a Q&A to the chosen field (knowledge base / instructions /
// behavior), then mark the question taught.
export async function teachAgent(
  questionId: string,
  agentId: string,
  field: "knowledgeBase" | "instructions" | "behavior",
  question: string,
  answer: string
): Promise<{ ok: boolean; message: string }> {
  const col = field === "knowledgeBase" ? "knowledge_base" : field;
  const { data: agent } = await supabase.from("agents").select(`id, name, ${col}`).eq("id", agentId).maybeSingle();
  if (!agent) return { ok: false, message: "Agent not found." };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (agent as any)[col] ?? "";
  const addition = `\n\nQ: ${question.trim()}\nA: ${answer.trim()}`;
  const { error } = await supabase.from("agents").update({ [col]: `${existing}${addition}`.trim() }).eq("id", agentId);
  if (error) return { ok: false, message: error.message };
  await supabase.from("learning_questions").update({ status: "taught" }).eq("id", questionId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ok: true, message: `Taught to ${(agent as any).name}.` };
}

export async function deleteLearningQuestion(id: string): Promise<void> {
  try {
    await supabase.from("learning_questions").delete().eq("id", id);
  } catch {
    /* ignore */
  }
}

// ----------------------------------------------------------- connections (0026)

export interface Connection {
  provider: string;
  status: string;
  accountLabel: string;
  accessMode: "read" | "write";
}

// This clinic's connected integrations (Google, etc.). Status only — no tokens.
// The internal voice_engine preference row is filtered out — it's a setting,
// not an integration.
export async function fetchConnections(): Promise<Connection[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("connections").select("*").eq("workspace_id", ws);
    return (data ?? [])
      .filter((r) => r.provider !== "voice_engine" && r.provider !== "pipeline_stages")
      .map((r) => ({ provider: r.provider, status: r.status ?? "connected", accountLabel: r.account_label ?? "", accessMode: r.access_mode === "write" ? "write" : "read" }));
  } catch {
    return [];
  }
}

// ----------------------------------------------- pipeline stage list (custom)
// The clinic's custom pipeline stage list (id + name, in order). Stored as a
// JSON blob in a connections row (provider "pipeline_stages") — no migration
// needed, same pattern as the voice_engine preference. Null = nothing saved
// yet (use the defaults).
export interface PipelineStageDef { id: string; name: string }

export async function fetchPipelineStages(): Promise<PipelineStageDef[] | null> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("connections").select("account_label").eq("workspace_id", ws).eq("provider", "pipeline_stages").limit(1).maybeSingle();
    if (!data?.account_label) return null;
    const parsed = JSON.parse(data.account_label);
    return Array.isArray(parsed) && parsed.length ? parsed.filter((s) => s?.id && s?.name) : null;
  } catch {
    return null;
  }
}

export async function savePipelineStages(stages: PipelineStageDef[]): Promise<void> {
  try {
    const ws = await getWorkspaceId();
    if (!ws) return;
    await supabase.from("connections").delete().eq("workspace_id", ws).eq("provider", "pipeline_stages");
    await supabase.from("connections").insert({
      workspace_id: ws,
      provider: "pipeline_stages",
      status: "connected",
      account_label: JSON.stringify(stages.map((s) => ({ id: s.id, name: s.name }))),
    });
  } catch {
    /* keep local state; retried on the next change */
  }
}

// ------------------------------------------------------- WhatsApp live stats
// Real numbers for the WhatsApp page (replacing the old hardcoded samples).
export interface WaStats { chats: number; botReplies30d: number; booked30d: number }

export async function fetchWaStats(): Promise<WaStats> {
  const out: WaStats = { chats: 0, botReplies30d: 0, booked30d: 0 };
  try {
    const ws = await getWorkspaceId();
    const since = new Date(Date.now() - 30 * 86400000).toISOString();
    const sinceDate = since.slice(0, 10);
    const [convos, bot, booked] = await Promise.all([
      supabase.from("wa_conversations").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("channel", "whatsapp"),
      supabase.from("wa_messages").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("by_bot", true).gte("created_at", since),
      supabase.from("appointments").select("id", { count: "exact", head: true }).eq("workspace_id", ws).eq("confirmed_via", "whatsapp").gte("date", sinceDate),
    ]);
    out.chats = convos.count ?? 0;
    out.botReplies30d = bot.count ?? 0;
    out.booked30d = booked.count ?? 0;
  } catch {
    /* zeros are honest when the tables are missing */
  }
  return out;
}

// -------------------------------------------------- voice engine (xAI / Vapi)
// Which provider powers the clinic's voice agents. Stored as a row in the
// connections table (provider "voice_engine", choice in account_label) so no
// migration is needed. Default: xAI Grok Voice.
export type VoiceProvider = "xai" | "vapi";

export async function fetchVoiceProvider(): Promise<VoiceProvider> {
  try {
    const ws = await getWorkspaceId();
    // limit(1): if duplicate rows ever exist, don't error out — read one.
    const { data } = await supabase.from("connections").select("account_label").eq("workspace_id", ws).eq("provider", "voice_engine").limit(1).maybeSingle();
    return data?.account_label === "vapi" ? "vapi" : "xai";
  } catch {
    return "xai";
  }
}

// Save = replace: delete any existing voice_engine row(s) then insert fresh —
// idempotent, immune to duplicate rows and to update-vs-insert races. Then
// VERIFY by reading back, so the UI can never show a switch that didn't stick.
export async function saveVoiceProvider(p: VoiceProvider): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  try {
    await supabase.from("connections").delete().eq("workspace_id", ws).eq("provider", "voice_engine");
    const { error } = await supabase.from("connections").insert({ workspace_id: ws, provider: "voice_engine", status: "connected", account_label: p });
    if (error) return { ok: false, message: `Could not save the voice engine: ${error.message}` };
    const now = await fetchVoiceProvider();
    if (now !== p) return { ok: false, message: "The engine choice didn't persist — check the connections table permissions and try again." };
    return { ok: true, message: p === "xai" ? "Voice engine set to xAI Grok Voice." : "Voice engine set to Vapi." };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : "Could not save the voice engine." };
  }
}

export async function setConnectionAccessMode(provider: string, mode: "read" | "write"): Promise<void> {
  const ws = await getWorkspaceId();
  if (!ws) return;
  try {
    await supabase.from("connections").update({ access_mode: mode }).eq("workspace_id", ws).eq("provider", provider);
  } catch {
    /* column may not exist yet */
  }
}

export async function disconnectConnection(provider: string): Promise<{ ok: boolean }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false };
  try {
    await fetch("/api/connections/disconnect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId: ws, provider }),
    });
    // Also remove the status row directly (demo-open RLS) so the UI updates even
    // if the service-role key isn't set.
    await supabase.from("connections").delete().eq("workspace_id", ws).eq("provider", provider);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ----------------------------------------------------------- clinic settings (0025)

export interface ClinicSettings {
  website: string;
  showSampleData: boolean;
  timezone: string;
  displayName: string;
}

// -------------------------------------------------------- pipeline deals (0049)
export interface PipelineDealRecord {
  id: string;
  patientName: string;
  treatment: string;
  value: number;
  source: string;
  owner: string;
  stageName: string;
}

export async function fetchPipelineDeals(): Promise<PipelineDealRecord[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("pipeline_deals").select("*").eq("workspace_id", ws).order("created_at", { ascending: false });
    return (data ?? []).map((r) => ({ id: r.id, patientName: r.patient_name ?? "", treatment: r.treatment ?? "", value: Number(r.value ?? 0), source: r.source ?? "manual", owner: r.owner ?? "", stageName: r.stage_name ?? "New Lead" }));
  } catch {
    return [];
  }
}

export async function createPipelineDeal(input: { patientName: string; treatment: string; value: number; source: string; owner: string; stageName: string }): Promise<{ ok: boolean; id?: string; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { data, error } = await supabase.from("pipeline_deals").insert({ workspace_id: ws, patient_name: input.patientName, treatment: input.treatment, value: input.value, source: input.source, owner: input.owner, stage_name: input.stageName }).select("id").single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: data?.id, message: "Deal added." };
}

export async function updatePipelineDeal(id: string, patch: { stageName?: string; owner?: string }): Promise<void> {
  const row: Record<string, unknown> = {};
  if (patch.stageName !== undefined) row.stage_name = patch.stageName;
  if (patch.owner !== undefined) row.owner = patch.owner;
  try { await supabase.from("pipeline_deals").update(row).eq("id", id); } catch { /* demo */ }
}

export async function deletePipelineDeal(id: string): Promise<void> {
  try { await supabase.from("pipeline_deals").delete().eq("id", id); } catch { /* demo */ }
}

// ------------------------------------------------- native email/SMS broadcasts
export interface MessageBroadcast {
  id: string;
  name: string;
  channel: "email" | "sms";
  folderId: string | null;
  folderName: string;
  subject: string;
  status: "Draft" | "Scheduled" | "Sending" | "Sent" | "Failed";
  scheduledFor: string | null;
  recipients: number;
  sent: number;
  failed: number;
  sentAt: string | null;
  createdAt: string;
}

export async function fetchMessageBroadcasts(channel: "email" | "sms"): Promise<MessageBroadcast[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("message_broadcasts").select("*").eq("workspace_id", ws).eq("channel", channel).order("created_at", { ascending: false }).limit(50);
    return (data ?? []).map((r) => ({
      id: r.id, name: r.name ?? "", channel: r.channel, folderId: r.folder_id ?? null, folderName: r.folder_name ?? "",
      subject: r.subject ?? "", status: r.status, scheduledFor: r.scheduled_for ?? null,
      recipients: r.recipients ?? 0, sent: r.sent ?? 0, failed: r.failed ?? 0, sentAt: r.sent_at ?? null, createdAt: r.created_at,
    }));
  } catch {
    return [];
  }
}

export async function deleteMessageBroadcast(id: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("message_broadcasts").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Broadcast deleted." };
}

// ------------------------------------------------------------------- tags
export interface ClinicTag { id: string; name: string; color: string }

export async function fetchTags(): Promise<ClinicTag[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("clinic_tags").select("*").eq("workspace_id", ws).order("created_at");
    return (data ?? []).map((r) => ({ id: r.id, name: r.name, color: r.color ?? "#7c3aed" }));
  } catch {
    return [];
  }
}

export async function addTag(name: string, color: string): Promise<{ ok: boolean; id?: string; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { data, error } = await supabase.from("clinic_tags").insert({ workspace_id: ws, name, color }).select("id").single();
  if (error) return { ok: false, message: error.message };
  return { ok: true, id: data?.id, message: "Tag added." };
}

export async function deleteTag(id: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("clinic_tags").delete().eq("id", id);
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Tag removed." };
}

export async function fetchClinicSettings(): Promise<ClinicSettings> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("clinic_settings").select("*").eq("workspace_id", ws).maybeSingle();
    return { website: data?.website ?? "", showSampleData: data?.show_sample_data ?? true, timezone: data?.timezone ?? "Asia/Dubai", displayName: data?.display_name ?? "" };
  } catch {
    return { website: "", showSampleData: true, timezone: "Asia/Dubai", displayName: "" };
  }
}

export async function saveClinicSettings(s: Partial<ClinicSettings>): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { data: existing } = await supabase.from("clinic_settings").select("workspace_id").eq("workspace_id", ws).maybeSingle();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const row: Record<string, any> = { updated_at: new Date().toISOString() };
  if (s.website !== undefined) row.website = s.website.trim();
  if (s.showSampleData !== undefined) row.show_sample_data = s.showSampleData;
  if (s.timezone !== undefined) row.timezone = s.timezone;
  if (s.displayName !== undefined) row.display_name = s.displayName.trim();
  let { error } = existing
    ? await supabase.from("clinic_settings").update(row).eq("workspace_id", ws)
    : await supabase.from("clinic_settings").insert({ workspace_id: ws, ...row });
  // Older DBs without the display_name column — retry without it.
  if (error && /display_name/.test(error.message)) {
    delete row.display_name;
    ({ error } = existing
      ? await supabase.from("clinic_settings").update(row).eq("workspace_id", ws)
      : await supabase.from("clinic_settings").insert({ workspace_id: ws, ...row }));
  }
  // Older DBs without the timezone column — retry without it.
  if (error && /timezone/.test(error.message)) {
    delete row.timezone;
    ({ error } = existing
      ? await supabase.from("clinic_settings").update(row).eq("workspace_id", ws)
      : await supabase.from("clinic_settings").insert({ workspace_id: ws, ...row }));
  }
  // Older DBs without the show_sample_data column — retry without it.
  if (error && /show_sample_data/.test(error.message)) {
    delete row.show_sample_data;
    ({ error } = existing
      ? await supabase.from("clinic_settings").update(row).eq("workspace_id", ws)
      : await supabase.from("clinic_settings").insert({ workspace_id: ws, ...row }));
  }
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Saved." };
}

// ----------------------------------------------------------- custom voices (0024)

export interface CustomVoice {
  id: string;
  voiceId: string; // provider (ElevenLabs) voice id
  name: string;
  gender: string;
  accent: string;
}

// This clinic's own cloned voices (premade voices come from /api/voice/list).
export async function fetchCustomVoices(): Promise<CustomVoice[]> {
  try {
    const ws = await getWorkspaceId();
    const { data } = await supabase.from("voices").select("*").eq("workspace_id", ws).order("created_at", { ascending: false });
    return (data ?? []).map((r) => ({ id: r.id, voiceId: r.voice_id, name: r.name ?? "Custom voice", gender: r.gender ?? "", accent: r.accent ?? "" }));
  } catch {
    return [];
  }
}

export async function saveCustomVoice(voiceId: string, name: string, gender = "", accent = ""): Promise<{ ok: boolean; message: string }> {
  const ws = await getWorkspaceId();
  if (!ws) return { ok: false, message: "Sign in first." };
  const { error } = await supabase.from("voices").insert({ workspace_id: ws, voice_id: voiceId, name: name.trim() || "Custom voice", gender, accent });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Custom voice saved." };
}

export async function removeCustomVoice(id: string): Promise<void> {
  try {
    await supabase.from("voices").delete().eq("id", id);
  } catch {
    /* ignore */
  }
}
