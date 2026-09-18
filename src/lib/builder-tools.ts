// LiveKit Builder HTTP tool adapter — request-handling logic.
//
// LiveKit Builder's HTTP Actions send a FLAT JSON body of tool parameters
// (verified against docs.livekit.io/agents/start/builder.md): no nesting and
// no fixed envelope fields, so the worker's /api/agents/tool-exec
// {agentId, name, args} shape is unreachable from Builder. This adapter puts
// the agent id and tool name in the ROUTE PATH
// (/api/builder-tools/<agentId>/<tool>) and treats the whole body as the
// tool's arguments.
//
// Every request is authenticated (Authorization: Bearer <worker token> — the
// same secret the deployed worker presents, resolved by resolveWorkerToken)
// and workspace-matched before any tool runs. Responses are structured JSON
// whose `success` comes from what the handlers actually did — never from
// parsing prose, and no patient/provider/appointment id is ever invented.
//
// This module is PURE: every service (auth, booking, patients, knowledge,
// email) is injected through BuilderToolDeps, so tests exercise the full
// pipeline with mocks and fictional records. The route file
// (src/app/api/builder-tools/[agentId]/[tool]/route.ts) wires the real
// implementations.
//
// Deliberately NOT served here: end_call (native to the voice session /
// Builder's built-in tool) and transfer_call (SIP-side, outside HTTP).

import { normalizeVoiceSettings } from "@/lib/agent-config";
import type {
  BookingCtx,
  SlotsResult,
  BookingResult,
  UpcomingAppointment,
  ApptActionResult,
} from "@/lib/booking-server";
import type { LookupPatientResult, CreatePatientResult, KnowledgeResult } from "@/lib/agent-tools-core";
import type { EmailSendResult } from "@/lib/email-send";

export interface BuilderAgentRow {
  id: string;
  name: string;
  workspace_id: string | null;
  voice_settings?: unknown;
  can_book?: boolean | null;
  can_reschedule?: boolean | null;
  can_cancel?: boolean | null;
  knowledge_base?: string | null;
}

export interface BuilderToolDeps {
  resolveToken(token: unknown): Promise<{ ok: boolean; ws?: string; error?: string }>;
  getSlots(ws: string | null, args: Record<string, unknown>): Promise<SlotsResult>;
  book(ctx: BookingCtx, args: Record<string, unknown>): Promise<BookingResult>;
  findPatientId(ws: string | null, phone?: string | null, email?: string | null): Promise<string | null>;
  listUpcoming(ws: string | null, patientId: string): Promise<UpcomingAppointment[]>;
  findAppointment(
    ws: string | null,
    ref: { id?: string; externalId?: string }
  ): Promise<{ ok: true; appt: UpcomingAppointment } | { ok: false; error: string }>;
  rescheduleRow(ctx: BookingCtx, appt: UpcomingAppointment, datetime: string): Promise<ApptActionResult>;
  cancelRow(ctx: BookingCtx, appt: UpcomingAppointment): Promise<ApptActionResult>;
  lookupPatient(ws: string | null, q: { phone?: unknown; name?: unknown }): Promise<LookupPatientResult>;
  createPatient(ws: string | null, agentName: string, q: { name?: unknown; phone?: unknown; email?: unknown }): Promise<CreatePatientResult>;
  searchKnowledge(agent: { name?: string | null; knowledge_base?: string | null }, a: { query?: unknown; context?: unknown }): Promise<KnowledgeResult>;
  sendEmail(input: { to: string; subject: string; body: string; ws?: string; fromName?: string }): Promise<EmailSendResult>;
}

export interface BuilderHttpResult {
  status: number;
  body: Record<string, unknown>;
}

// The tools this adapter serves. end_call / transfer_call are intentionally
// absent (native / SIP-side); search_knowledge is always available (the worker
// registers it unconditionally too); everything else obeys the agent's
// enabled-tool settings from normalizeVoiceSettings.
const SERVED_TOOLS = new Set([
  "get_available_slots",
  "book_appointment",
  "reschedule_appointment",
  "cancel_appointment",
  "lookup_patient",
  "create_patient",
  "send_email",
  "search_knowledge",
]);

const NATIVE_TOOLS = new Set(["end_call", "transfer_call"]);

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function fail(status: number, error: string, extra?: Record<string, unknown>): BuilderHttpResult {
  return { status, body: { success: false, error, ...(extra ?? {}) } };
}

function bearerToken(header: unknown): string {
  const h = str(header);
  return h.replace(/^bearer\s+/i, "").trim();
}

// Map a requested tool name (plus its args, for action-style aliases) onto the
// canonical Pydent tool id — or explain why it can't be served.
export function resolveBuilderTool(
  tool: string,
  args: Record<string, unknown>
): { ok: true; canonical: string } | { ok: false; status: number; error: string } {
  const name = str(tool).toLowerCase().replace(/-/g, "_");
  if (!name) return { ok: false, status: 404, error: "No tool name in the request path." };
  if (NATIVE_TOOLS.has(name)) {
    return {
      ok: false,
      status: 400,
      error: `${name} is handled natively by the voice session (Builder's built-in tool / SIP transfer) — it is not served over HTTP.`,
    };
  }
  if (name === "knowledge_base") return { ok: true, canonical: "search_knowledge" };
  if (name === "manage_appointment") {
    const action = str(args.action).toLowerCase();
    if (action === "reschedule") return { ok: true, canonical: "reschedule_appointment" };
    if (action === "cancel") return { ok: true, canonical: "cancel_appointment" };
    return { ok: false, status: 400, error: 'manage_appointment needs "action": "reschedule" or "cancel".' };
  }
  if (!SERVED_TOOLS.has(name)) return { ok: false, status: 404, error: `Unknown tool "${name.slice(0, 60)}".` };
  return { ok: true, canonical: name };
}

// Is the canonical tool switched on for this agent? Uses the same
// normalizeVoiceSettings defaults/clamps as the worker's per-call config, so
// the HTTP adapter can never run a tool the agent has disabled.
export function builderToolEnabled(agent: BuilderAgentRow, canonical: string): boolean {
  if (canonical === "search_knowledge") return true; // always-on, like the worker
  const vs = normalizeVoiceSettings(agent.voice_settings, {
    canBook: !!agent.can_book,
    canReschedule: !!agent.can_reschedule,
    canCancel: !!agent.can_cancel,
  }) as { tools?: Record<string, boolean> };
  return vs.tools?.[canonical] === true;
}

// Shared reschedule/cancel flow. The target appointment is either the EXACT
// reference the caller supplied (Pydent appointment_id UUID, or Open Dental
// apt_num) validated against the workspace AND the resolved patient — or, with
// no reference, the patient's single upcoming appointment. With zero or
// several upcoming appointments nothing is modified: the choices are returned
// so the agent can ask the caller which one.
async function manageAppointment(
  deps: BuilderToolDeps,
  agent: BuilderAgentRow,
  canonical: "reschedule_appointment" | "cancel_appointment",
  args: Record<string, unknown>
): Promise<BuilderHttpResult> {
  const ws = agent.workspace_id ?? null;
  const datetime = str(args.datetime);
  if (canonical === "reschedule_appointment" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(datetime)) {
    return fail(400, 'reschedule_appointment needs "datetime" as YYYY-MM-DDTHH:MM.');
  }

  const phone = str(args.phone);
  const email = str(args.email);
  // The caller must be identifiable before an appointment can be changed —
  // this NEVER creates a patient record (unlike booking).
  if (!phone && !email) {
    return {
      status: 200,
      body: { success: false, error: "patient_not_identified", message: "Provide the patient's phone or email so the appointment can be verified before changing it." },
    };
  }
  const patientId = await deps.findPatientId(ws, phone, email);
  if (!patientId) {
    return { status: 200, body: { success: false, error: "patient_not_found", message: "No matching patient record found — nothing was changed." } };
  }

  const apptShape = (a: UpcomingAppointment) => ({
    appointment_id: a.id,
    apt_num: a.external_id ?? null,
    date: a.date,
    time: a.time,
    procedure: a.procedure,
    provider: a.provider,
  });

  const apptId = str(args.appointment_id);
  const aptNum = str(args.apt_num ?? args.external_id);
  let target: UpcomingAppointment;
  if (apptId || aptNum) {
    const found = await deps.findAppointment(ws, apptId ? { id: apptId } : { externalId: aptNum });
    if (!found.ok) {
      return { status: 200, body: { success: false, error: found.error, message: "That appointment reference was not found in this clinic — nothing was changed." } };
    }
    if (found.appt.patient_id !== patientId) {
      return {
        status: 200,
        body: { success: false, error: "appointment_ownership_mismatch", message: "That appointment does not belong to the identified patient — nothing was changed." },
      };
    }
    target = found.appt;
  } else {
    const upcoming = await deps.listUpcoming(ws, patientId);
    if (upcoming.length === 0) {
      return { status: 200, body: { success: false, error: "no_upcoming_appointment", appointments: [], message: "No upcoming appointment found for this patient." } };
    }
    if (upcoming.length > 1) {
      return {
        status: 200,
        body: {
          success: false,
          error: "ambiguous_appointment",
          ambiguous: true,
          appointments: upcoming.map(apptShape),
          message: "This patient has several upcoming appointments — ask which one, then call again with its appointment_id. Nothing was changed.",
        },
      };
    }
    target = upcoming[0];
  }

  const ctx: BookingCtx = {
    ws,
    patientId,
    name: str(args.name),
    phone,
    source: "voice",
    bookedBy: agent.name,
  };
  const r = canonical === "reschedule_appointment"
    ? await deps.rescheduleRow(ctx, target, datetime)
    : await deps.cancelRow(ctx, target);
  return {
    status: 200,
    body: {
      success: r.success,
      ...(r.error ? { error: r.error } : {}),
      appointment_id: target.id,
      apt_num: target.external_id ?? null,
      ...(canonical === "reschedule_appointment" && r.success ? { date: r.date, time: r.time } : {}),
      message: r.spoken,
    },
  };
}

// The full request pipeline: authenticate → resolve agent → workspace match →
// tool gate → dispatch. Status codes: 401/403 auth, 404 unknown agent/tool,
// 400 caller mistakes (bad body/arguments), 200 for every domain outcome —
// success:false in a 200 body is a truthful "it did not happen" the model can
// read reliably.
export async function handleBuilderToolRequest(
  deps: BuilderToolDeps,
  req: { authHeader: unknown; agent: BuilderAgentRow | null; tool: string; args: unknown }
): Promise<BuilderHttpResult> {
  // 1) Credentials — checked before anything about the agent is revealed.
  const token = bearerToken(req.authHeader);
  if (!token) return fail(401, "Missing credentials. Send Authorization: Bearer <worker token>.");
  let auth: { ok: boolean; ws?: string; error?: string };
  try {
    auth = await deps.resolveToken(token);
  } catch {
    return fail(401, "Credential check failed.");
  }
  if (!auth.ok) return fail(401, "Invalid credentials.");

  // 2) Agent + workspace match. A workspace-scoped token may only reach agents
  // of its own workspace; the global env token has no workspace binding.
  if (!req.agent) return fail(404, "Agent not found.");
  const agent = req.agent;
  if (auth.ws && auth.ws !== String(agent.workspace_id ?? "")) {
    return fail(403, "This credential is not authorized for this agent's workspace.");
  }

  // 3) Arguments: Builder POST bodies are flat JSON objects of parameters.
  if (req.args !== undefined && req.args !== null && (typeof req.args !== "object" || Array.isArray(req.args))) {
    return fail(400, "Request body must be a flat JSON object of tool arguments.");
  }
  const args = (req.args ?? {}) as Record<string, unknown>;

  // 4) Tool gate.
  const resolved = resolveBuilderTool(req.tool, args);
  if (!resolved.ok) return fail(resolved.status, resolved.error);
  const canonical = resolved.canonical;
  if (!builderToolEnabled(agent, canonical)) {
    return fail(403, `The ${canonical} tool is disabled for this agent.`);
  }

  const ws = agent.workspace_id ?? null;
  try {
    switch (canonical) {
      case "lookup_patient": {
        const r = await deps.lookupPatient(ws, { phone: args.phone, name: args.name });
        if (r.error === "missing_query") return fail(400, "Provide a phone number or a name to look up.");
        return {
          status: 200,
          body: {
            success: true,
            found: r.found,
            patients: r.patients.map((p) => ({
              patient_id: p.id,
              name: p.name,
              phone: p.phone,
              email: p.email,
              next_appointment: p.next_appointment,
              insurance: p.insurance,
            })),
            message: r.found
              ? `Found ${r.patients.length} matching patient record${r.patients.length === 1 ? "" : "s"}.`
              : "No matching patient record found — they may be a new patient.",
          },
        };
      }
      case "create_patient": {
        if (!str(args.name)) return fail(400, "A name is required to create a patient record.");
        const r = await deps.createPatient(ws, agent.name, { name: args.name, phone: args.phone, email: args.email });
        if (!r.success) {
          return { status: 200, body: { success: false, error: "db_error", message: "Could not create the patient record." } };
        }
        return {
          status: 200,
          body: {
            success: true,
            created: r.created,
            duplicate: !!r.duplicate,
            patient_id: r.patientId ?? null,
            message: r.duplicate
              ? `A record already exists for this phone number (${r.existingName}) — no duplicate was created.`
              : `Created a new patient record for ${r.name}.`,
          },
        };
      }
      case "search_knowledge": {
        if (!str(args.query)) return fail(400, "Provide a query describing what to look up.");
        const r = await deps.searchKnowledge(agent, { query: args.query, context: args.context });
        return {
          status: 200,
          body: {
            success: true,
            found: r.found,
            result: r.found
              ? `Relevant clinic knowledge (answer ONLY from this; if the specific fact isn't here, say you don't have it):\n${r.text}`
              : "The knowledge base has no information about that.",
            sources: r.sources.map((s) => ({ source: s.source, score: s.score })),
          },
        };
      }
      case "get_available_slots": {
        const date = str(args.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(400, 'get_available_slots needs "date" as YYYY-MM-DD.');
        const r = await deps.getSlots(ws, { date, doctor: str(args.doctor), service: str(args.service), treatment: str(args.treatment) });
        return {
          status: 200,
          body: { success: r.success, ...(r.error ? { error: r.error } : {}), date: r.date ?? date, slots: r.slots ?? [], source: r.source, message: r.spoken },
        };
      }
      case "book_appointment": {
        const datetime = str(args.datetime);
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(datetime)) return fail(400, 'book_appointment needs "datetime" as YYYY-MM-DDTHH:MM.');
        const ctx: BookingCtx = {
          ws,
          patientId: null,
          name: str(args.name),
          phone: str(args.phone),
          source: "voice",
          bookedBy: agent.name,
        };
        const r = await deps.book(ctx, {
          firstName: str(args.firstName || args.first_name),
          lastName: str(args.lastName || args.last_name),
          name: str(args.name),
          email: str(args.email),
          phone: str(args.phone),
          service: str(args.service),
          treatment: str(args.treatment),
          fee: typeof args.fee === "number" || typeof args.fee === "string" ? args.fee : undefined,
          doctor: str(args.doctor),
          datetime,
        });
        return {
          status: 200,
          body: {
            success: r.success,
            ...(r.error ? { error: r.error } : {}),
            ...(r.success
              ? {
                  appointment_id: r.appointmentId,   // Pydent UUID; the Open Dental AptNum syncs in the background and is not known yet
                  patient_id: r.patientId ?? null,
                  date: r.date,
                  time: r.time,
                  treatment: r.treatment,
                  provider: r.provider,
                  fee: r.fee ?? null,
                }
              : {}),
            message: r.spoken,
          },
        };
      }
      case "reschedule_appointment":
      case "cancel_appointment":
        return manageAppointment(deps, agent, canonical, args);
      case "send_email": {
        const to = str(args.to);
        if (!to) return fail(400, 'send_email needs "to" (the recipient address).');
        const r = await deps.sendEmail({ to, subject: str(args.subject), body: str(args.body), ws: ws ?? undefined, fromName: agent.name });
        return { status: 200, body: { success: r.sent, ...(r.sent ? {} : { error: "email_not_sent" }), message: r.message } };
      }
      default:
        return fail(404, `Unknown tool "${canonical}".`);
    }
  } catch {
    // Never leak internals (DB messages can contain patient details).
    return fail(500, "Tool execution failed.");
  }
}
