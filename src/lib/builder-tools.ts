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
// CONTRACT: Pydent-native only. Appointments are created, read, rescheduled
// and cancelled in the Pydent Calendar; identifiers are Pydent UUIDs
// (patient_id, appointment_id) and human fields (date, time, doctor,
// service, status). No Open Dental vocabulary is accepted or returned —
// background mirrors (Open Dental / Google Calendar) keep running where
// configured, but nothing here depends on or reports them.
//
// Every request is authenticated (Authorization: Bearer <workspace worker
// token from Pydent → Settings → LiveKit>) and workspace-matched before any
// tool runs; the unbound global env token is NOT accepted here. Responses
// are structured JSON — `success` from what the handlers actually did,
// `reason` as a machine code on failure/ambiguity, `spoken` as a sentence
// the agent can relay. Nothing is ever inferred from prose and no id is
// ever invented.
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
import type { PatientHit, LookupPatientResult, CreatePatientResult, KnowledgeResult } from "@/lib/agent-tools-core";
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
  getPatient(ws: string | null, id: string): Promise<PatientHit | null>;
  listUpcoming(ws: string | null, patientId: string): Promise<UpcomingAppointment[]>;
  findAppointment(
    ws: string | null,
    ref: { id?: string }
  ): Promise<{ ok: true; appt: UpcomingAppointment } | { ok: false; error: string }>;
  rescheduleRow(ctx: BookingCtx, appt: UpcomingAppointment, datetime: string): Promise<ApptActionResult>;
  cancelRow(ctx: BookingCtx, appt: UpcomingAppointment): Promise<ApptActionResult>;
  lookupPatient(ws: string | null, q: { phone?: unknown; name?: unknown; email?: unknown }): Promise<LookupPatientResult>;
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
// enabled-tool settings. list_upcoming_appointments reveals the same data as
// lookup_patient, so it shares that tool's switch.
const SERVED_TOOLS = new Set([
  "get_available_slots",
  "book_appointment",
  "reschedule_appointment",
  "cancel_appointment",
  "lookup_patient",
  "create_patient",
  "list_upcoming_appointments",
  "send_email",
  "search_knowledge",
]);

const NATIVE_TOOLS = new Set(["end_call", "transfer_call"]);

// Availability searches cover at most this many days per call.
export const MAX_AVAILABILITY_DAYS = 14;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function fail(status: number, reason: string, spoken: string): BuilderHttpResult {
  return { status, body: { success: false, reason, spoken } };
}

function bearerToken(header: unknown): string {
  const h = str(header);
  return h.replace(/^bearer\s+/i, "").trim();
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// Pydent-native shapes returned to Builder.
function patientShape(p: PatientHit) {
  return { patient_id: p.id, name: p.name, phone: p.phone, email: p.email, insurance: p.insurance };
}

function appointmentShape(a: UpcomingAppointment) {
  return {
    appointment_id: a.id,
    date: a.date,
    time: String(a.time ?? "").slice(0, 5),
    doctor: a.provider ?? "",
    service: a.procedure ?? "",
    status: a.status ?? "Scheduled",
  };
}

// Map a requested tool name (plus its args, for action-style aliases) onto the
// canonical Pydent tool id — or explain why it can't be served.
export function resolveBuilderTool(
  tool: string,
  args: Record<string, unknown>
): { ok: true; canonical: string } | { ok: false; status: number; reason: string; spoken: string } {
  const name = str(tool).toLowerCase().replace(/-/g, "_");
  if (!name) return { ok: false, status: 404, reason: "unknown_tool", spoken: "No tool name in the request path." };
  if (NATIVE_TOOLS.has(name)) {
    return {
      ok: false,
      status: 400,
      reason: "native_tool",
      spoken: `${name} is handled natively by the voice session (Builder's built-in tool / SIP transfer) — it is not served over HTTP.`,
    };
  }
  if (name === "knowledge_base") return { ok: true, canonical: "search_knowledge" };
  if (name === "manage_appointment") {
    const action = str(args.action).toLowerCase();
    if (action === "reschedule") return { ok: true, canonical: "reschedule_appointment" };
    if (action === "cancel") return { ok: true, canonical: "cancel_appointment" };
    return { ok: false, status: 400, reason: "invalid_arguments", spoken: 'manage_appointment needs "action": "reschedule" or "cancel".' };
  }
  if (!SERVED_TOOLS.has(name)) return { ok: false, status: 404, reason: "unknown_tool", spoken: `Unknown tool "${name.slice(0, 60)}".` };
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
  // list_upcoming_appointments shares lookup_patient's switch (same data).
  const gate = canonical === "list_upcoming_appointments" ? "lookup_patient" : canonical;
  return vs.tools?.[gate] === true;
}

// Identify the patient a request is about, WITHOUT ever creating a record:
// an explicit patient_id (validated in this workspace) wins; otherwise a
// phone/email match against existing patients.
async function resolvePatientRef(
  deps: BuilderToolDeps,
  ws: string | null,
  args: Record<string, unknown>
): Promise<{ ok: true; patientId: string } | { ok: false; res: BuilderHttpResult }> {
  const patientId = str(args.patient_id);
  const phone = str(args.phone);
  const email = str(args.email);
  if (patientId) {
    const p = await deps.getPatient(ws, patientId);
    if (!p) {
      return { ok: false, res: { status: 200, body: { success: false, reason: "patient_not_found", spoken: "No patient with that patient_id exists in this clinic." } } };
    }
    return { ok: true, patientId: p.id };
  }
  if (!phone && !email) {
    return {
      ok: false,
      res: { status: 200, body: { success: false, reason: "patient_not_identified", spoken: "Provide the patient's patient_id, phone, or email so the record can be verified first." } },
    };
  }
  const found = await deps.findPatientId(ws, phone, email);
  if (!found) {
    return { ok: false, res: { status: 200, body: { success: false, reason: "patient_not_found", spoken: "No matching patient record found — nothing was changed." } } };
  }
  return { ok: true, patientId: found };
}

// Enumerate YYYY-MM-DD dates from start to end inclusive (already validated).
function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T00:00:00Z`);
  const stop = new Date(`${end}T00:00:00Z`);
  while (d <= stop && out.length < MAX_AVAILABILITY_DAYS) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Shared reschedule/cancel flow. The target appointment is either the EXACT
// Pydent appointment_id the caller supplied — validated against the workspace
// AND the resolved patient — or, with no id, the patient's single upcoming
// appointment. With zero or several upcoming appointments nothing is
// modified: the choices (if any) are returned so the agent can ask the
// caller which one. The next appointment is NEVER auto-selected when several
// exist.
export async function manageAppointmentFlow(
  deps: BuilderToolDeps,
  agent: BuilderAgentRow,
  canonical: "reschedule_appointment" | "cancel_appointment",
  args: Record<string, unknown>
): Promise<BuilderHttpResult> {
  const ws = agent.workspace_id ?? null;
  const datetime = str(args.datetime);
  if (canonical === "reschedule_appointment" && !DATETIME_RE.test(datetime)) {
    return fail(400, "invalid_arguments", 'reschedule_appointment needs "datetime" as YYYY-MM-DDTHH:MM.');
  }

  const resolved = await resolvePatientRef(deps, ws, args);
  if (!resolved.ok) return resolved.res;
  const patientId = resolved.patientId;

  const apptId = str(args.appointment_id);
  let target: UpcomingAppointment;
  if (apptId) {
    const found = await deps.findAppointment(ws, { id: apptId });
    if (!found.ok) {
      const cancelled = found.error === "appointment_cancelled";
      return {
        status: 200,
        body: {
          success: false,
          reason: found.error,
          spoken: cancelled
            ? "That appointment is already cancelled — nothing was changed."
            : "That appointment_id was not found in this clinic — nothing was changed.",
        },
      };
    }
    if (found.appt.patient_id !== patientId) {
      return {
        status: 200,
        body: { success: false, reason: "appointment_ownership_mismatch", spoken: "That appointment does not belong to the identified patient — nothing was changed." },
      };
    }
    target = found.appt;
  } else {
    const upcoming = await deps.listUpcoming(ws, patientId);
    if (upcoming.length === 0) {
      return { status: 200, body: { success: false, reason: "appointment_not_found", appointments: [], spoken: "No upcoming appointment found for this patient." } };
    }
    if (upcoming.length > 1) {
      return {
        status: 200,
        body: {
          success: false,
          reason: "ambiguous_appointment",
          ambiguous: true,
          appointments: upcoming.map(appointmentShape),
          spoken: "This patient has several upcoming appointments — ask which one, then call again with its appointment_id. Nothing was changed.",
        },
      };
    }
    target = upcoming[0];
  }

  const ctx: BookingCtx = {
    ws,
    patientId,
    name: str(args.name),
    phone: str(args.phone),
    source: "voice",
    bookedBy: agent.name,
  };
  if (canonical === "reschedule_appointment") {
    const r = await deps.rescheduleRow(ctx, target, datetime);
    return {
      status: 200,
      body: {
        success: r.success,
        ...(r.error ? { reason: r.error } : {}),
        appointment_id: target.id,
        ...(r.success ? { appointment: { ...appointmentShape(target), date: r.date, time: r.time } } : {}),
        spoken: r.spoken,
      },
    };
  }
  const r = await deps.cancelRow(ctx, target);
  return {
    status: 200,
    body: { success: r.success, ...(r.error ? { reason: r.error } : {}), appointment_id: target.id, spoken: r.spoken },
  };
}

// All of the resolved patient's upcoming appointments, in the Pydent shape.
// Shared by the Builder HTTP adapter and the worker's tool-exec endpoint.
export async function listUpcomingFlow(
  deps: BuilderToolDeps,
  agent: BuilderAgentRow,
  args: Record<string, unknown>
): Promise<BuilderHttpResult> {
  const ws = agent.workspace_id ?? null;
  const resolved = await resolvePatientRef(deps, ws, args);
  if (!resolved.ok) return resolved.res;
  const appointments = (await deps.listUpcoming(ws, resolved.patientId)).map(appointmentShape);
  return {
    status: 200,
    body: {
      success: true,
      found: appointments.length > 0,
      patient_id: resolved.patientId,
      appointments,
      spoken: appointments.length
        ? `This patient has ${appointments.length} upcoming appointment${appointments.length === 1 ? "" : "s"}.`
        : "This patient has no upcoming appointments.",
    },
  };
}

// Voice-friendly prose for a flow result: the spoken sentence, plus an
// enumerated choice list whenever appointments were returned, so the LLM can
// read real options to the caller and then act on an exact appointment_id —
// never invented, never auto-selected.
export function voiceSpoken(body: Record<string, unknown>): string {
  const spoken = String(body.spoken ?? "");
  const appts = Array.isArray(body.appointments) ? (body.appointments as Record<string, unknown>[]) : [];
  if (!appts.length) return spoken;
  const lines = appts.map(
    (a, i) => `${i + 1}. ${a.date} at ${a.time}${a.doctor ? ` with ${a.doctor}` : ""}${a.service ? ` for ${a.service}` : ""} — appointment_id ${a.appointment_id}`
  );
  return `${spoken}\n${lines.join("\n")}`;
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
  if (!token) return fail(401, "unauthorized", "Missing credentials. Send Authorization: Bearer <workspace worker token>.");
  let auth: { ok: boolean; ws?: string; error?: string };
  try {
    auth = await deps.resolveToken(token);
  } catch {
    return fail(401, "unauthorized", "Credential check failed.");
  }
  if (!auth.ok) return fail(401, "unauthorized", "Invalid credentials.");

  // 2) Agent + workspace binding. The Builder adapter only accepts tokens
  // BOUND to a workspace (Pydent → Settings → LiveKit), and only for agents
  // of that same workspace — the unbound global env token is refused.
  if (!req.agent) return fail(404, "agent_not_found", "Agent not found.");
  const agent = req.agent;
  if (!auth.ws) {
    return fail(403, "unbound_token", "This credential is not bound to a workspace. Use the workspace worker token from Pydent → Settings → LiveKit.");
  }
  if (auth.ws !== String(agent.workspace_id ?? "")) {
    return fail(403, "forbidden_workspace", "This credential is not authorized for this agent's workspace.");
  }

  // 3) Arguments: Builder POST bodies are flat JSON objects of parameters.
  if (req.args !== undefined && req.args !== null && (typeof req.args !== "object" || Array.isArray(req.args))) {
    return fail(400, "invalid_arguments", "Request body must be a flat JSON object of tool arguments.");
  }
  const args = (req.args ?? {}) as Record<string, unknown>;

  // 4) Tool gate.
  const resolvedTool = resolveBuilderTool(req.tool, args);
  if (!resolvedTool.ok) return fail(resolvedTool.status, resolvedTool.reason, resolvedTool.spoken);
  const canonical = resolvedTool.canonical;
  if (!builderToolEnabled(agent, canonical)) {
    return fail(403, "tool_disabled", `The ${canonical} tool is disabled for this agent.`);
  }

  const ws = agent.workspace_id ?? null;
  try {
    switch (canonical) {
      case "lookup_patient": {
        const phone = str(args.phone);
        const name = str(args.name);
        const email = str(args.email);
        if (!phone && !name && !email) return fail(400, "invalid_arguments", "Provide a phone number, name, or email to look up.");
        const r = await deps.lookupPatient(ws, { phone, name, email });
        if (!r.found) {
          return { status: 200, body: { success: true, found: false, spoken: "No matching patient record found — they may be a new patient." } };
        }
        if (r.patients.length > 1) {
          return {
            status: 200,
            body: {
              success: true,
              found: true,
              ambiguous: true,
              reason: "ambiguous_patient",
              patients: r.patients.map(patientShape),
              spoken: "Several patient records match — ask for another detail (full name, phone, or email) to narrow it down. No record was selected.",
            },
          };
        }
        const p = r.patients[0];
        const appointments = (await deps.listUpcoming(ws, p.id)).map(appointmentShape);
        return {
          status: 200,
          body: {
            success: true,
            found: true,
            patient_id: p.id,
            patient: patientShape(p),
            appointments,
            spoken: `Found ${p.name ?? "the patient"}'s record${appointments.length ? ` with ${appointments.length} upcoming appointment${appointments.length === 1 ? "" : "s"}` : " — no upcoming appointments"}.`,
          },
        };
      }
      case "create_patient": {
        const name = str(args.name);
        if (!name) return fail(400, "invalid_arguments", "A name is required to create a patient record.");
        const phone = str(args.phone);
        const email = str(args.email);
        // Never create a duplicate: an existing phone/email match is returned
        // instead (lookup-only — this check cannot create anything).
        if (phone || email) {
          const existing = await deps.findPatientId(ws, phone, email);
          if (existing) {
            return {
              status: 200,
              body: { success: true, created: false, duplicate: true, patient_id: existing, spoken: "A matching patient record already exists — no duplicate was created." },
            };
          }
        }
        const r = await deps.createPatient(ws, agent.name, { name, phone, email });
        if (!r.success) {
          return { status: 200, body: { success: false, reason: "db_error", spoken: "Could not create the patient record." } };
        }
        if (r.duplicate) {
          return { status: 200, body: { success: true, created: false, duplicate: true, patient_id: r.patientId ?? null, spoken: "A matching patient record already exists — no duplicate was created." } };
        }
        return { status: 200, body: { success: true, created: true, duplicate: false, patient_id: r.patientId ?? null, spoken: `Created a new patient record for ${r.name}.` } };
      }
      case "search_knowledge": {
        if (!str(args.query)) return fail(400, "invalid_arguments", "Provide a query describing what to look up.");
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
        // Single date or a range (start_date..end_date, capped at
        // MAX_AVAILABILITY_DAYS): a thin wrapper over the Pydent Calendar's
        // per-day availability, so only genuinely bookable times come back.
        const start = str(args.start_date) || str(args.date);
        const endRaw = str(args.end_date) || start;
        if (!DATE_RE.test(start)) return fail(400, "invalid_arguments", 'get_available_slots needs "date" or "start_date" as YYYY-MM-DD.');
        if (!DATE_RE.test(endRaw) || endRaw < start) return fail(400, "invalid_arguments", '"end_date" must be YYYY-MM-DD and not before the start date.');
        const doctor = str(args.doctor);
        const service = str(args.service);
        const treatment = str(args.treatment);
        const dates = dateRange(start, endRaw);
        const end = dates[dates.length - 1];
        const perDay = await Promise.all(dates.map((date) => deps.getSlots(ws, { date, doctor, service, treatment })));
        const days = perDay.map((r, i) => ({ date: r.date ?? dates[i], available_slots: r.slots ?? [] }));
        const withSlots = days.filter((d) => d.available_slots.length > 0);
        const spoken = withSlots.length
          ? `Open times — ${withSlots.slice(0, 3).map((d) => `${d.date}: ${d.available_slots.slice(0, 6).join(", ")}`).join("; ")}.`
          : dates.length === 1
            ? `No open times on ${start}${doctor ? ` for ${doctor}` : ""} — suggest another day.`
            : `No open times between ${start} and ${end}${doctor ? ` for ${doctor}` : ""} — suggest different dates.`;
        return { status: 200, body: { success: true, start_date: start, end_date: end, days, spoken } };
      }
      case "book_appointment": {
        const datetime = str(args.datetime);
        if (!DATETIME_RE.test(datetime)) return fail(400, "invalid_arguments", 'book_appointment needs "datetime" as YYYY-MM-DDTHH:MM.');
        const patientIdArg = str(args.patient_id);
        const phone = str(args.phone);
        const name = str(args.name);
        if (!patientIdArg && !phone && !name) {
          return fail(400, "invalid_arguments", 'book_appointment needs "patient_id", or the caller\'s "name"/"phone", to know who the appointment is for.');
        }
        // Identify the patient WITHOUT creating: an explicit patient_id must
        // exist in this workspace; otherwise try a phone/email match. Booking
        // may still create a new lead when nothing matches (existing Pydent
        // behaviour for new callers) — but a known patient must never get a
        // duplicate appointment at the same time.
        let patientId: string | null = null;
        if (patientIdArg) {
          const p = await deps.getPatient(ws, patientIdArg);
          if (!p) return { status: 200, body: { success: false, reason: "patient_not_found", spoken: "No patient with that patient_id exists in this clinic — nothing was booked." } };
          patientId = p.id;
        } else if (phone || str(args.email)) {
          patientId = await deps.findPatientId(ws, phone, str(args.email));
        }
        if (patientId) {
          const date = datetime.slice(0, 10);
          const time = datetime.slice(11, 16);
          const dup = (await deps.listUpcoming(ws, patientId)).find((u) => u.date === date && String(u.time ?? "").slice(0, 5) === time);
          if (dup) {
            return {
              status: 200,
              body: { success: false, reason: "duplicate_booking", appointment: appointmentShape(dup), spoken: "This patient already has an appointment at that exact time — no duplicate was booked." },
            };
          }
        }
        const ctx: BookingCtx = { ws, patientId, name, phone, source: "voice", bookedBy: agent.name };
        const r = await deps.book(ctx, {
          firstName: str(args.firstName || args.first_name),
          lastName: str(args.lastName || args.last_name),
          name,
          email: str(args.email),
          phone,
          service: str(args.service),
          treatment: str(args.treatment),
          fee: typeof args.fee === "number" || typeof args.fee === "string" ? args.fee : undefined,
          doctor: str(args.doctor),
          datetime,
        });
        if (!r.success) {
          return { status: 200, body: { success: false, reason: r.error ?? "booking_failed", spoken: r.spoken } };
        }
        return {
          status: 200,
          body: {
            success: true,
            appointment_id: r.appointmentId,
            patient_id: r.patientId ?? null,
            appointment: {
              appointment_id: r.appointmentId,
              date: r.date,
              time: r.time,
              doctor: r.provider ?? "",
              service: r.treatment ?? "",
              status: "Scheduled",
            },
            spoken: r.spoken,
          },
        };
      }
      case "list_upcoming_appointments":
        return listUpcomingFlow(deps, agent, args);
      case "reschedule_appointment":
      case "cancel_appointment":
        return manageAppointmentFlow(deps, agent, canonical, args);
      case "send_email": {
        const to = str(args.to);
        if (!to) return fail(400, "invalid_arguments", 'send_email needs "to" (the recipient address).');
        const r = await deps.sendEmail({ to, subject: str(args.subject), body: str(args.body), ws: ws ?? undefined, fromName: agent.name });
        return { status: 200, body: { success: r.sent, ...(r.sent ? {} : { reason: "email_not_sent" }), spoken: r.message } };
      }
      default:
        return fail(404, "unknown_tool", `Unknown tool "${canonical}".`);
    }
  } catch {
    // Never leak internals (DB messages can contain patient details).
    return fail(500, "tool_failed", "Tool execution failed.");
  }
}
