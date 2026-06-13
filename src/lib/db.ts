// Live data layer (Supabase) with graceful fallback to the bundled demo
// dataset when the database is unreachable or hasn't been migrated yet.

import { supabase } from "./supabase";
import {
  patients as mockPatients,
  appointments as mockAppointments,
  treatmentPlans as mockPlans,
  patientDocuments as mockDocs,
  insurancePolicies as mockInsurance,
  payments as mockPayments,
  type Patient,
  type Appointment,
  type TreatmentPlan,
  type PatientDocument,
  type InsurancePolicy,
  type Payment,
} from "./mock-data";

export type DataSource = "live" | "demo";

// Some networks leave a failed connection hanging instead of rejecting —
// race every primary query against a timeout so the demo fallback engages.
function withTimeout<T>(p: PromiseLike<T>, ms = 6000): Promise<T> {
  return Promise.race([
    Promise.resolve(p),
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("db timeout")), ms)),
  ]);
}

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
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchPatients(): Promise<{ patients: Patient[]; source: DataSource }> {
  try {
    const { data, error } = await withTimeout(supabase.from("patients").select("*").order("name"));
    if (error || !data) throw error ?? new Error("no data");
    return { patients: data.map(rowToPatient), source: "live" };
  } catch {
    return { patients: mockPatients, source: "demo" };
  }
}

export async function fetchAppointments(): Promise<{ appointments: Appointment[]; source: DataSource }> {
  try {
    const { data, error } = await withTimeout(
      supabase.from("appointments").select("*, patients(name)").order("date")
    );
    if (error || !data) throw error ?? new Error("no data");
    return {
      appointments: data.map((r) => rowToAppointment(r, r.patients?.name ?? "Unknown")),
      source: "live",
    };
  } catch {
    return { appointments: mockAppointments, source: "demo" };
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
    const { data: p, error } = await withTimeout(supabase.from("patients").select("*").eq("id", id).single());
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
    // Demo fallback (mock ids like "p1")
    const patient = mockPatients.find((p) => p.id === id);
    if (!patient) return null;
    return {
      patient,
      appointments: mockAppointments.filter((a) => a.patientId === id),
      plans: mockPlans.filter((t) => t.patientId === id),
      documents: mockDocs.filter((d) => d.patientId === id),
      insurance: mockInsurance.filter((i) => i.patientId === id),
      payments: mockPayments.filter((p2) => p2.patientId === id),
      source: "demo",
    };
  }
}

export async function createPatient(input: {
  name: string;
  phone: string;
  email: string;
  birthdate: string;
  insurance: string;
  status: string;
}): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("patients").insert({
    name: input.name,
    phone: input.phone,
    email: input.email,
    birthdate: input.birthdate || null,
    insurance: input.insurance || "Self-pay",
    status: input.status,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Patient created and saved to the database." };
}

export async function createAppointment(input: {
  patientId: string;
  provider: string;
  operatory: string;
  procedure: string;
  date: string;
  time: string;
}): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("appointments").insert({
    patient_id: input.patientId,
    provider: input.provider,
    operatory: input.operatory,
    procedure: input.procedure || "Prophylaxis + exam",
    date: input.date,
    time: input.time,
    status: "Scheduled",
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Appointment saved to the schedule." };
}

// ----------------------------------------------------------------- agents

export interface AiAgent {
  id: string;
  name: string;
  kind: "chat" | "voice";
  role: "Receptionist" | "Sales" | "Knowledge base" | "Appointment setter" | "Follow-up";
  status: "Live" | "Paused" | "Draft";
  model: string;
  vapiAssistantId: string | null;
  voice: string;
  firstMessage: string;
  language: string;
  instructions: string;
  knowledgeBase: string;
  canBook: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  channels: string[];
  purpose: "inbound" | "outbound" | "both";
  firstMessageMode: "assistant_first" | "user_first" | "assistant_first_generated";
  kbFiles: string[];
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
    firstMessage: r.first_message ?? "",
    language: r.language ?? "English",
    instructions: r.instructions ?? "",
    knowledgeBase: r.knowledge_base ?? "",
    canBook: !!r.can_book,
    canReschedule: !!r.can_reschedule,
    canCancel: !!r.can_cancel,
    channels: r.channels ?? [],
    purpose: r.purpose ?? "both",
    firstMessageMode: r.first_message_mode ?? "assistant_first",
    kbFiles: r.kb_files ?? [],
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
    first_message: input.firstMessage,
    language: input.language,
    instructions: input.instructions,
    knowledge_base: input.knowledgeBase,
    can_book: input.canBook,
    can_reschedule: input.canReschedule,
    can_cancel: input.canCancel,
    channels: input.channels,
    purpose: input.purpose,
    first_message_mode: input.firstMessageMode,
    kb_files: input.kbFiles,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function fetchAgents(): Promise<{ agents: AiAgent[]; source: DataSource }> {
  try {
    const { data, error } = await withTimeout(supabase.from("agents").select("*").order("created_at"));
    if (error || !data) throw error ?? new Error("no data");
    return { agents: data.map(rowToAgent), source: "live" };
  } catch {
    return { agents: [], source: "demo" };
  }
}

export async function createAgent(input: Omit<AiAgent, "id" | "vapiAssistantId">): Promise<{ ok: boolean; message: string; id?: string }> {
  const row = agentToRow(input);
  let { data, error } = await supabase.from("agents").insert(row).select("id").single();
  if (error && /purpose|first_message_mode|kb_files/.test(error.message)) {
    // Migration 0003 not applied yet — retry without the new columns.
    delete row.purpose;
    delete row.first_message_mode;
    delete row.kb_files;
    ({ data, error } = await supabase.from("agents").insert(row).select("id").single());
  }
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Agent saved to the database.", id: data?.id };
}

export async function setAgentVapiId(id: string, vapiId: string): Promise<void> {
  await supabase.from("agents").update({ vapi_assistant_id: vapiId }).eq("id", id);
}

export async function updateAgent(id: string, input: Omit<AiAgent, "id" | "vapiAssistantId">): Promise<{ ok: boolean; message: string }> {
  const row = agentToRow(input);
  let { error } = await supabase.from("agents").update(row).eq("id", id);
  if (error && /purpose|first_message_mode|kb_files/.test(error.message)) {
    delete row.purpose;
    delete row.first_message_mode;
    delete row.kb_files;
    ({ error } = await supabase.from("agents").update(row).eq("id", id));
  }
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Agent updated." };
}

// ----------------------------------------------- agent hub (defaults/lines)

export interface ChannelDefault {
  channel: string;
  agentId: string | null;
  enabled: boolean;
}

export async function fetchChannelDefaults(): Promise<ChannelDefault[]> {
  try {
    const { data } = await supabase.from("channel_defaults").select("*");
    return (data ?? []).map((r) => ({ channel: r.channel, agentId: r.agent_id, enabled: r.enabled }));
  } catch {
    return [];
  }
}

export async function setChannelDefault(channel: string, agentId: string | null, enabled: boolean): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase
    .from("channel_defaults")
    .upsert({ channel, agent_id: agentId, enabled, updated_at: new Date().toISOString() }, { onConflict: "channel" });
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
    const { data } = await supabase.from("phone_lines").select("*").order("created_at");
    return (data ?? []).map((r) => ({ id: r.id, number: r.number, agentId: r.agent_id, direction: r.direction, active: r.active }));
  } catch {
    return [];
  }
}

export async function addPhoneLine(number: string, agentId: string | null, direction: PhoneLine["direction"]): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("phone_lines").upsert({ number, agent_id: agentId, direction, active: true }, { onConflict: "number" });
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
  await supabase
    .from("agent_assignments")
    .upsert({ conversation_key: conversationKey, agent_id: agentId, active: true }, { onConflict: "conversation_key" });
}

export async function fetchAssignments(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.from("agent_assignments").select("conversation_key, agent_id").eq("active", true);
    return Object.fromEntries((data ?? []).map((r) => [r.conversation_key, r.agent_id]));
  } catch {
    return {};
  }
}

export async function enrollFollowUp(dealKey: string, agentId: string, patientName: string): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase
    .from("follow_ups")
    .upsert({ deal_key: dealKey, agent_id: agentId, patient_name: patientName, active: true }, { onConflict: "deal_key" });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Enrolled in daily follow-up." };
}

export async function fetchFollowUps(): Promise<Record<string, string>> {
  try {
    const { data } = await supabase.from("follow_ups").select("deal_key, agent_id").eq("active", true);
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
    const { data } = await supabase.from("patient_folders").select("*").order("name");
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
    const { data, error } = await withTimeout(supabase.from("wa_templates").select("*").order("created_at", { ascending: false }));
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

// ------------------------------------------------------------ instagram posts

export interface IgPost {
  id: string;
  caption: string;
  mediaName: string;
  scheduledFor: string; // YYYY-MM-DD
  time: string;
  status: "Draft" | "Scheduled" | "Published";
}

export async function fetchIgPosts(): Promise<IgPost[]> {
  try {
    const { data } = await supabase.from("ig_posts").select("*").order("scheduled_for");
    return (data ?? []).map((r) => ({
      id: r.id,
      caption: r.caption,
      mediaName: r.media_name ?? "",
      scheduledFor: r.scheduled_for,
      time: r.time ?? "10:00",
      status: r.status,
    }));
  } catch {
    return [];
  }
}

export async function createIgPost(p: Omit<IgPost, "id">): Promise<{ ok: boolean; message: string }> {
  const { error } = await supabase.from("ig_posts").insert({
    caption: p.caption,
    media_name: p.mediaName,
    scheduled_for: p.scheduledFor,
    time: p.time,
    status: p.status,
  });
  if (error) return { ok: false, message: error.message };
  return { ok: true, message: "Post scheduled." };
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
  type: "trigger" | "message" | "condition" | "agent" | "wait" | "action" | "handoff";
  title: string;
  detail: string;
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
    const { data, error } = await withTimeout(supabase.from("workflows").select("*").order("created_at"));
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
    const { data, error } = await supabase.from("workflows").select("*").eq("id", id).single();
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

export async function deleteWorkflow(id: string): Promise<void> {
  await supabase.from("workflows").delete().eq("id", id);
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
    await supabase
      .from("tooth_chart_marks")
      .upsert({ patient_id: patientId, tooth, condition, updated_at: new Date().toISOString() }, { onConflict: "patient_id,tooth" });
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
    const { data } = await supabase.from("pipeline_stage_agents").select("stage_id, agent_id").not("agent_id", "is", null);
    return Object.fromEntries((data ?? []).map((r) => [r.stage_id, r.agent_id]));
  } catch {
    return {};
  }
}

export async function setStageAgentDb(stageId: string, agentId: string | null): Promise<void> {
  try {
    await supabase
      .from("pipeline_stage_agents")
      .upsert({ stage_id: stageId, agent_id: agentId, updated_at: new Date().toISOString() }, { onConflict: "stage_id" });
  } catch {
    /* demo mode */
  }
}
