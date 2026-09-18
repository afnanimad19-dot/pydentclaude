// Builder HTTP tool adapter: authentication, workspace matching, enabled-tool
// gating (incl. aliases), flat-argument validation, truthful structured
// success/failure, ambiguous-appointment handling, and exact ownership.
// Everything runs against MOCKED services and fictional records — no database,
// no network, no real patient data.

import { test } from "node:test";
import assert from "node:assert/strict";

const { handleBuilderToolRequest, resolveBuilderTool, builderToolEnabled } =
  await import("@/lib/builder-tools");

// ── Fictional fixtures ───────────────────────────────────────────────────────
const WS = "ws-test-0000";
const AGENT = {
  id: "agent-test-0000",
  name: "Test Receptionist",
  workspace_id: WS,
  voice_settings: {},
  can_book: true,
  can_reschedule: true,
  can_cancel: true,
  knowledge_base: "--- Clinic FAQ ---\nWe are open 9 to 5.",
};

const APPT_A = { id: "appt-aaa", external_id: "301", google_calendar_event_id: null, patient_id: "pat-1", date: "2099-01-10", time: "10:00", procedure: "Cleaning", provider: "Dr. Demo" };
const APPT_B = { id: "appt-bbb", external_id: null, google_calendar_event_id: null, patient_id: "pat-1", date: "2099-02-01", time: "14:30", procedure: "Filling", provider: "Dr. Demo" };
const APPT_OTHER = { id: "appt-zzz", external_id: "999", google_calendar_event_id: null, patient_id: "pat-OTHER", date: "2099-03-01", time: "09:00", procedure: "Exam", provider: "Dr. Demo" };

// deps where every service records calls; override per test.
function makeDeps(overrides = {}) {
  const calls = { reschedule: [], cancel: [], book: [], email: [] };
  const deps = {
    resolveToken: async (t) => (t === "good-global" ? { ok: true } : t === "good-ws" ? { ok: true, ws: WS } : t === "other-ws" ? { ok: true, ws: "ws-OTHER" } : { ok: false, error: "bad" }),
    getSlots: async (ws, a) => ({ success: true, date: a.date, slots: ["09:00", "09:30"], source: "local", spoken: `Open slots on ${a.date}: 09:00, 09:30.` }),
    book: async (ctx, a) => { calls.book.push({ ctx, a }); return { success: true, appointmentId: "appt-new", patientId: "pat-1", date: "2099-01-10", time: "10:00", treatment: "Cleaning", provider: "", fee: null, spoken: "Appointment booked: Cleaning on 2099-01-10 at 10:00." }; },
    findPatientId: async (ws, phone) => (phone === "+15550001111" ? "pat-1" : null),
    listUpcoming: async () => [APPT_A],
    findAppointment: async (ws, ref) => {
      const all = [APPT_A, APPT_B, APPT_OTHER];
      const hit = ref.id ? all.find((x) => x.id === ref.id) : all.find((x) => x.external_id === ref.externalId);
      return hit ? { ok: true, appt: hit } : { ok: false, error: "appointment_not_found" };
    },
    rescheduleRow: async (ctx, appt, dt) => { calls.reschedule.push({ appt, dt }); return { success: true, appointmentId: appt.id, externalId: appt.external_id, date: dt.slice(0, 10), time: dt.slice(11, 16), spoken: "Rescheduled." }; },
    cancelRow: async (ctx, appt) => { calls.cancel.push({ appt }); return { success: true, appointmentId: appt.id, externalId: appt.external_id, spoken: "Cancelled." }; },
    lookupPatient: async (ws, q) => (!String(q.phone ?? "").trim() && !String(q.name ?? "").trim()
      ? { success: false, error: "missing_query", found: false, patients: [] }
      : { success: true, found: true, patients: [{ id: "pat-1", name: "Pat Fictional", phone: "+15550001111", email: null, next_appointment: null, insurance: null }] }),
    createPatient: async (ws, agentName, q) => ({ success: true, created: true, duplicate: false, patientId: "pat-new", name: String(q.name) }),
    searchKnowledge: async () => ({ success: true, found: true, text: "We are open 9 to 5.", sources: [{ source: "Clinic FAQ", id: 0, score: 3 }] }),
    sendEmail: async () => ({ sent: true, message: "Email sent to x@example.com." }),
    ...overrides,
  };
  return { deps, calls };
}

const call = (deps, over = {}) =>
  handleBuilderToolRequest(deps, {
    authHeader: "Bearer good-ws",
    agent: AGENT,
    tool: "lookup_patient",
    args: { phone: "+15550001111" },
    ...over,
  });

// ── Authentication ───────────────────────────────────────────────────────────
test("missing Authorization header → 401, no tool runs", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { authHeader: null });
  assert.equal(r.status, 401);
  assert.equal(r.body.success, false);
});

test("invalid token → 401", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { authHeader: "Bearer wrong" });
  assert.equal(r.status, 401);
});

test("token bound to ANOTHER workspace → 403", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { authHeader: "Bearer other-ws" });
  assert.equal(r.status, 403);
});

test("global env token (no workspace binding) is accepted", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { authHeader: "Bearer good-global" });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
});

test("workspace-matched token is accepted; Bearer prefix optional", async () => {
  const { deps } = makeDeps();
  assert.equal((await call(deps)).status, 200);
  assert.equal((await call(deps, { authHeader: "good-ws" })).status, 200);
});

test("valid token + unknown agent → 404 (auth still checked first)", async () => {
  const { deps } = makeDeps();
  assert.equal((await call(deps, { agent: null })).status, 404);
  // Without credentials the agent's existence is never revealed:
  assert.equal((await call(deps, { agent: null, authHeader: null })).status, 401);
});

// ── Tool gating ──────────────────────────────────────────────────────────────
test("disabled tool → 403 and the handler is never invoked", async () => {
  const { deps, calls } = makeDeps();
  const agent = { ...AGENT, voice_settings: { tools: { book_appointment: false } } };
  const r = await call(deps, { agent, tool: "book_appointment", args: { datetime: "2099-01-10T10:00" } });
  assert.equal(r.status, 403);
  assert.equal(calls.book.length, 0);
});

test("legacy can_* flags gate the appointment tools", async () => {
  const { deps, calls } = makeDeps();
  const agent = { ...AGENT, can_cancel: false, voice_settings: {} };
  const r = await call(deps, { agent, tool: "cancel_appointment", args: { phone: "+15550001111" } });
  assert.equal(r.status, 403);
  assert.equal(calls.cancel.length, 0);
});

test("end_call and transfer_call are refused as native tools", async () => {
  const { deps } = makeDeps();
  for (const tool of ["end_call", "transfer_call"]) {
    const r = await call(deps, { tool, args: {} });
    assert.equal(r.status, 400);
    assert.match(String(r.body.error), /natively/);
  }
});

test("unknown tool → 404", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { tool: "drop_all_tables", args: {} });
  assert.equal(r.status, 404);
});

test("alias: knowledge_base → search_knowledge (always available)", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { tool: "knowledge_base", args: { query: "opening hours" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
  assert.match(String(r.body.result), /answer ONLY from this/);
});

test("alias: manage_appointment routes by action and respects gating", async () => {
  const { deps, calls } = makeDeps();
  const ok = await call(deps, { tool: "manage_appointment", args: { action: "cancel", phone: "+15550001111" } });
  assert.equal(ok.status, 200);
  assert.equal(calls.cancel.length, 1);
  const bad = await call(deps, { tool: "manage_appointment", args: { action: "explode" } });
  assert.equal(bad.status, 400);
  const gated = await call(deps, {
    agent: { ...AGENT, voice_settings: { tools: { reschedule_appointment: false } } },
    tool: "manage_appointment",
    args: { action: "reschedule", phone: "+15550001111", datetime: "2099-01-11T10:00" },
  });
  assert.equal(gated.status, 403);
});

// ── Argument validation ──────────────────────────────────────────────────────
test("non-object body → 400", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { args: [1, 2, 3] });
  assert.equal(r.status, 400);
});

test("missing required arguments → 400, nothing executed", async () => {
  const { deps, calls } = makeDeps();
  assert.equal((await call(deps, { tool: "get_available_slots", args: {} })).status, 400);
  assert.equal((await call(deps, { tool: "get_available_slots", args: { date: "tomorrow" } })).status, 400);
  assert.equal((await call(deps, { tool: "book_appointment", args: { name: "Pat" } })).status, 400);
  assert.equal((await call(deps, { tool: "search_knowledge", args: {} })).status, 400);
  assert.equal((await call(deps, { tool: "lookup_patient", args: {} })).status, 400);
  assert.equal((await call(deps, { tool: "create_patient", args: { phone: "+15550001111" } })).status, 400);
  assert.equal((await call(deps, { tool: "send_email", args: { subject: "hi" } })).status, 400);
  assert.equal(calls.book.length, 0);
});

// ── Truthful success / failure ───────────────────────────────────────────────
test("booking success carries the handler's real ids — nothing fabricated", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { tool: "book_appointment", args: { datetime: "2099-01-10T10:00", name: "Pat Fictional", phone: "+15550001111", treatment: "Cleaning" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.appointment_id, "appt-new"); // exactly what the mock handler returned
  assert.equal(r.body.patient_id, "pat-1");
});

test("booking failure (slot taken) is reported as failure, no ids invented", async () => {
  const { deps } = makeDeps({
    book: async () => ({ success: false, error: "slot_taken", date: "2099-01-10", time: "10:00", spoken: "That slot (2099-01-10 10:00) is already taken — offer the patient a different open time." }),
  });
  const r = await call(deps, { tool: "book_appointment", args: { datetime: "2099-01-10T10:00" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, "slot_taken");
  assert.equal("appointment_id" in r.body, false);
});

test("email result mirrors the actual send outcome", async () => {
  const failing = makeDeps({ sendEmail: async () => ({ sent: false, message: "Email isn't connected." }) });
  const r = await call(failing.deps, { tool: "send_email", args: { to: "x@example.com", subject: "s", body: "b" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, "email_not_sent");
  const okDeps = makeDeps();
  const ok = await call(okDeps.deps, { tool: "send_email", args: { to: "x@example.com", subject: "s", body: "b" } });
  assert.equal(ok.body.success, true);
});

test("lookup_patient returns real records and a truthful not-found", async () => {
  const { deps } = makeDeps();
  const hit = await call(deps, {});
  assert.equal(hit.body.found, true);
  assert.equal(hit.body.patients[0].patient_id, "pat-1");
  const miss = makeDeps({ lookupPatient: async () => ({ success: true, found: false, patients: [] }) });
  const r = await call(miss.deps, {});
  assert.equal(r.body.found, false);
  assert.equal(r.body.patients.length, 0);
});

// ── Appointment targeting (correction 4) ─────────────────────────────────────
test("reschedule/cancel refuse to act without patient identification", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: {} });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, "patient_not_identified");
  assert.equal(calls.cancel.length, 0);
});

test("unknown patient → patient_not_found, nothing changed (never creates)", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { phone: "+19999999999" } });
  assert.equal(r.body.error, "patient_not_found");
  assert.equal(calls.cancel.length, 0);
});

test("zero upcoming appointments → failure with empty list", async () => {
  const { deps, calls } = makeDeps({ listUpcoming: async () => [] });
  const r = await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", datetime: "2099-01-11T10:00" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, "no_upcoming_appointment");
  assert.deepEqual(r.body.appointments, []);
  assert.equal(calls.reschedule.length, 0);
});

test("exactly one upcoming appointment → acted on, with its real ids", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { phone: "+15550001111" } });
  assert.equal(r.body.success, true);
  assert.equal(r.body.appointment_id, "appt-aaa");
  assert.equal(r.body.apt_num, "301"); // Open Dental AptNum kept distinct from the Pydent UUID
  assert.equal(calls.cancel[0].appt.id, "appt-aaa");
});

test("several upcoming appointments → ambiguous, choices returned, NOTHING modified", async () => {
  const { deps, calls } = makeDeps({ listUpcoming: async () => [APPT_A, APPT_B] });
  const r = await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", datetime: "2099-01-11T10:00" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, "ambiguous_appointment");
  assert.equal(r.body.ambiguous, true);
  assert.equal(r.body.appointments.length, 2);
  assert.equal(r.body.appointments[0].appointment_id, "appt-aaa");
  assert.equal(r.body.appointments[1].apt_num, null); // no OD id → truthfully null, never invented
  assert.equal(calls.reschedule.length, 0);
});

test("explicit appointment_id: acts on EXACTLY that appointment", async () => {
  const { deps, calls } = makeDeps({ listUpcoming: async () => [APPT_A, APPT_B] });
  const r = await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", appointment_id: "appt-bbb", datetime: "2099-02-02T09:00" } });
  assert.equal(r.body.success, true);
  assert.equal(calls.reschedule[0].appt.id, "appt-bbb");
  assert.equal(calls.reschedule[0].dt, "2099-02-02T09:00");
});

test("apt_num (Open Dental id) resolves separately from the Pydent UUID", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { phone: "+15550001111", apt_num: "301" } });
  assert.equal(r.body.success, true);
  assert.equal(calls.cancel[0].appt.id, "appt-aaa");
});

test("appointment belonging to a DIFFERENT patient → ownership mismatch, nothing changed", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { phone: "+15550001111", appointment_id: "appt-zzz" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.error, "appointment_ownership_mismatch");
  assert.equal(calls.cancel.length, 0);
});

test("nonexistent appointment reference → not found, nothing changed", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { phone: "+15550001111", appointment_id: "appt-nope" } });
  assert.equal(r.body.error, "appointment_not_found");
  assert.equal(calls.cancel.length, 0);
});

test("reschedule without a valid datetime → 400 before any lookup", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", datetime: "next tuesday" } });
  assert.equal(r.status, 400);
  assert.equal(calls.reschedule.length, 0);
});

// ── Handler exceptions never leak internals ─────────────────────────────────
test("a throwing handler → generic 500, no internal message in the body", async () => {
  const { deps } = makeDeps({ getSlots: async () => { throw new Error("db row for patient Jane Doe failed"); } });
  const r = await call(deps, { tool: "get_available_slots", args: { date: "2099-01-10" } });
  assert.equal(r.status, 500);
  assert.equal(String(r.body.error).includes("Jane"), false);
});

// ── Unit checks on the pure helpers ─────────────────────────────────────────
test("resolveBuilderTool normalizes case and dashes", () => {
  assert.equal(resolveBuilderTool("Lookup-Patient", {}).canonical, "lookup_patient");
  assert.equal(resolveBuilderTool("", {}).ok, false);
});

test("builderToolEnabled: search_knowledge is always on; transfer needs a number", () => {
  assert.equal(builderToolEnabled({ ...AGENT, voice_settings: { tools: {} } }, "search_knowledge"), true);
  assert.equal(builderToolEnabled({ ...AGENT, voice_settings: {} }, "book_appointment"), true);
  assert.equal(builderToolEnabled({ ...AGENT, can_book: false, voice_settings: {} }, "book_appointment"), false);
});
