// Builder HTTP tool adapter (Pydent-native contract): authentication,
// workspace binding, enabled-tool gating (incl. aliases), argument
// validation, patient found/not-found/ambiguous, duplicate-patient and
// duplicate-booking prevention, date-range availability, exact appointment
// ownership, and truthful structured responses with no Open Dental
// dependency. Everything runs against MOCKED services and fictional records —
// no database, no network, no real patient data.

import { test } from "node:test";
import assert from "node:assert/strict";

const { handleBuilderToolRequest, resolveBuilderTool, builderToolEnabled, MAX_AVAILABILITY_DAYS } =
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

const PAT_1 = { id: "pat-1", name: "Pat Fictional", phone: "+15550001111", email: "pat@example.com", next_appointment: null, insurance: null };
const PAT_2 = { id: "pat-2", name: "Pat Fictional Jr", phone: "+15550002222", email: null, next_appointment: null, insurance: null };

const APPT_A = { id: "appt-aaa", external_id: "301", google_calendar_event_id: null, patient_id: "pat-1", date: "2099-01-10", time: "10:00", procedure: "Cleaning", provider: "Dr. Demo", status: "Scheduled" };
const APPT_B = { id: "appt-bbb", external_id: null, google_calendar_event_id: null, patient_id: "pat-1", date: "2099-02-01", time: "14:30", procedure: "Filling", provider: "Dr. Demo", status: "Scheduled" };
const APPT_OTHER = { id: "appt-zzz", external_id: "999", google_calendar_event_id: null, patient_id: "pat-OTHER", date: "2099-03-01", time: "09:00", procedure: "Exam", provider: "Dr. Demo", status: "Scheduled" };

// deps where every service records calls; override per test.
function makeDeps(overrides = {}) {
  const calls = { reschedule: [], cancel: [], book: [], email: [], create: [], slots: [] };
  const deps = {
    resolveToken: async (t) => (t === "good-global" ? { ok: true } : t === "good-ws" ? { ok: true, ws: WS } : t === "other-ws" ? { ok: true, ws: "ws-OTHER" } : { ok: false, error: "bad" }),
    getSlots: async (ws, a) => { calls.slots.push(a.date); return { success: true, date: a.date, slots: ["09:00", "09:30"], source: "local", spoken: `Open slots on ${a.date}: 09:00, 09:30.` }; },
    book: async (ctx, a) => { calls.book.push({ ctx, a }); return { success: true, appointmentId: "appt-new", patientId: ctx.patientId ?? "pat-1", date: a.datetime.slice(0, 10), time: a.datetime.slice(11, 16), treatment: "Cleaning", provider: "", fee: null, spoken: "Appointment booked: Cleaning on 2099-01-10 at 10:00." }; },
    findPatientId: async (ws, phone, email) => (phone === "+15550001111" || email === "pat@example.com" ? "pat-1" : null),
    getPatient: async (ws, id) => (id === "pat-1" ? PAT_1 : null),
    listUpcoming: async () => [APPT_A],
    findAppointment: async (ws, ref) => {
      const all = [APPT_A, APPT_B, APPT_OTHER];
      const hit = all.find((x) => x.id === ref.id);
      return hit ? { ok: true, appt: hit } : { ok: false, error: "appointment_not_found" };
    },
    rescheduleRow: async (ctx, appt, dt) => { calls.reschedule.push({ appt, dt }); return { success: true, appointmentId: appt.id, externalId: appt.external_id, date: dt.slice(0, 10), time: dt.slice(11, 16), spoken: "Rescheduled." }; },
    cancelRow: async (ctx, appt) => { calls.cancel.push({ appt }); return { success: true, appointmentId: appt.id, externalId: appt.external_id, spoken: "Cancelled." }; },
    lookupPatient: async (ws, q) => (!String(q.phone ?? "").trim() && !String(q.name ?? "").trim() && !String(q.email ?? "").trim()
      ? { success: false, error: "missing_query", found: false, patients: [] }
      : { success: true, found: true, patients: [PAT_1] }),
    createPatient: async (ws, agentName, q) => { calls.create.push(q); return { success: true, created: true, duplicate: false, patientId: "pat-new", name: String(q.name) }; },
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

// ── Authentication + workspace binding ───────────────────────────────────────
test("missing Authorization header → 401, no tool runs", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { authHeader: null });
  assert.equal(r.status, 401);
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "unauthorized");
});

test("invalid token → 401", async () => {
  const { deps } = makeDeps();
  assert.equal((await call(deps, { authHeader: "Bearer wrong" })).status, 401);
});

test("token bound to ANOTHER workspace → 403", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { authHeader: "Bearer other-ws" });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "forbidden_workspace");
});

test("unbound global env token is REJECTED by the Builder adapter", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { authHeader: "Bearer good-global" });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "unbound_token");
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
  const r = await call(deps, { agent, tool: "book_appointment", args: { datetime: "2099-01-10T10:00", name: "Pat" } });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "tool_disabled");
  assert.equal(calls.book.length, 0);
});

test("legacy can_* flags gate the appointment tools", async () => {
  const { deps, calls } = makeDeps();
  const agent = { ...AGENT, can_cancel: false, voice_settings: {} };
  const r = await call(deps, { agent, tool: "cancel_appointment", args: { phone: "+15550001111" } });
  assert.equal(r.status, 403);
  assert.equal(calls.cancel.length, 0);
});

test("list_upcoming_appointments shares lookup_patient's switch", async () => {
  const { deps } = makeDeps();
  const agent = { ...AGENT, voice_settings: { tools: { lookup_patient: false } } };
  const r = await call(deps, { agent, tool: "list_upcoming_appointments", args: { phone: "+15550001111" } });
  assert.equal(r.status, 403);
});

test("end_call and transfer_call are refused as native tools", async () => {
  const { deps } = makeDeps();
  for (const tool of ["end_call", "transfer_call"]) {
    const r = await call(deps, { tool, args: {} });
    assert.equal(r.status, 400);
    assert.match(String(r.body.spoken), /natively/);
  }
});

test("unknown tool → 404", async () => {
  const { deps } = makeDeps();
  assert.equal((await call(deps, { tool: "drop_all_tables", args: {} })).status, 404);
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
  assert.equal((await call(deps, { args: [1, 2, 3] })).status, 400);
});

test("missing required arguments → 400, nothing executed", async () => {
  const { deps, calls } = makeDeps();
  assert.equal((await call(deps, { tool: "get_available_slots", args: {} })).status, 400);
  assert.equal((await call(deps, { tool: "get_available_slots", args: { start_date: "tomorrow" } })).status, 400);
  assert.equal((await call(deps, { tool: "get_available_slots", args: { start_date: "2099-01-10", end_date: "2099-01-05" } })).status, 400);
  assert.equal((await call(deps, { tool: "book_appointment", args: { name: "Pat" } })).status, 400);
  assert.equal((await call(deps, { tool: "book_appointment", args: { datetime: "2099-01-10T10:00" } })).status, 400); // no patient info at all
  assert.equal((await call(deps, { tool: "search_knowledge", args: {} })).status, 400);
  assert.equal((await call(deps, { tool: "lookup_patient", args: {} })).status, 400);
  assert.equal((await call(deps, { tool: "create_patient", args: { phone: "+15550001111" } })).status, 400);
  assert.equal((await call(deps, { tool: "send_email", args: { subject: "hi" } })).status, 400);
  assert.equal(calls.book.length, 0);
});

// ── lookup_patient: found / not found / ambiguous ────────────────────────────
test("single match returns patient_id, patient, and their upcoming appointments", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, {});
  assert.equal(r.body.success, true);
  assert.equal(r.body.found, true);
  assert.equal(r.body.patient_id, "pat-1");
  assert.equal(r.body.patient.patient_id, "pat-1");
  assert.equal(r.body.appointments.length, 1);
  assert.equal(r.body.appointments[0].appointment_id, "appt-aaa");
  assert.equal(r.body.appointments[0].doctor, "Dr. Demo");
  assert.equal(r.body.appointments[0].service, "Cleaning");
});

test("no match is a truthful not-found", async () => {
  const miss = makeDeps({ lookupPatient: async () => ({ success: true, found: false, patients: [] }) });
  const r = await call(miss.deps, {});
  assert.equal(r.body.success, true);
  assert.equal(r.body.found, false);
});

test("several matches → ambiguous, no record auto-selected", async () => {
  const multi = makeDeps({ lookupPatient: async () => ({ success: true, found: true, patients: [PAT_1, PAT_2] }) });
  const r = await call(multi.deps, { args: { name: "Pat" } });
  assert.equal(r.body.ambiguous, true);
  assert.equal(r.body.reason, "ambiguous_patient");
  assert.equal(r.body.patients.length, 2);
  assert.equal("patient_id" in r.body, false); // nothing chosen
});

test("lookup accepts email", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { args: { email: "pat@example.com" } });
  assert.equal(r.status, 200);
  assert.equal(r.body.found, true);
});

// ── create_patient: duplicates prevented via phone OR email ──────────────────
test("existing phone match prevents duplicate creation", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "create_patient", args: { name: "Pat Fictional", phone: "+15550001111" } });
  assert.equal(r.body.duplicate, true);
  assert.equal(r.body.created, false);
  assert.equal(r.body.patient_id, "pat-1"); // the REAL existing id
  assert.equal(calls.create.length, 0);     // create never ran
});

test("existing email match prevents duplicate creation", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "create_patient", args: { name: "Pat Fictional", email: "pat@example.com" } });
  assert.equal(r.body.duplicate, true);
  assert.equal(calls.create.length, 0);
});

test("new patient returns the actual Pydent patient_id", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { tool: "create_patient", args: { name: "New Person", phone: "+15559998888" } });
  assert.equal(r.body.success, true);
  assert.equal(r.body.created, true);
  assert.equal(r.body.patient_id, "pat-new"); // exactly what the mock insert returned
});

test("create failure is reported truthfully", async () => {
  const failing = makeDeps({ createPatient: async () => ({ success: false, error: "boom", created: false }) });
  const r = await call(failing.deps, { tool: "create_patient", args: { name: "New Person" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "db_error");
});

// ── Date-range availability ──────────────────────────────────────────────────
test("date range returns grouped days from the real per-day availability", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "get_available_slots", args: { start_date: "2099-01-10", end_date: "2099-01-12", doctor: "Dr. Demo" } });
  assert.equal(r.body.success, true);
  assert.equal(r.body.start_date, "2099-01-10");
  assert.equal(r.body.end_date, "2099-01-12");
  assert.equal(r.body.days.length, 3);
  assert.deepEqual(r.body.days[0], { date: "2099-01-10", available_slots: ["09:00", "09:30"] });
  assert.deepEqual(calls.slots, ["2099-01-10", "2099-01-11", "2099-01-12"]);
});

test("a single date works and long ranges are capped", async () => {
  const { deps, calls } = makeDeps();
  const one = await call(deps, { tool: "get_available_slots", args: { date: "2099-01-10" } });
  assert.equal(one.body.days.length, 1);
  calls.slots.length = 0;
  const big = await call(deps, { tool: "get_available_slots", args: { start_date: "2099-01-01", end_date: "2099-03-01" } });
  assert.equal(big.body.days.length, MAX_AVAILABILITY_DAYS);
  assert.equal(calls.slots.length, MAX_AVAILABILITY_DAYS);
});

test("fully booked days are reported empty, never invented", async () => {
  const empty = makeDeps({ getSlots: async (ws, a) => ({ success: true, date: a.date, slots: [], source: "local", spoken: "Fully booked." }) });
  const r = await call(empty.deps, { tool: "get_available_slots", args: { start_date: "2099-01-10", end_date: "2099-01-11" } });
  assert.equal(r.body.days.every((d) => d.available_slots.length === 0), true);
  assert.match(String(r.body.spoken), /No open times/);
});

// ── Booking ──────────────────────────────────────────────────────────────────
test("booking success carries the handler's real ids — nothing fabricated", async () => {
  const { deps } = makeDeps({ listUpcoming: async () => [] });
  const r = await call(deps, { tool: "book_appointment", args: { datetime: "2099-01-10T10:00", name: "Pat Fictional", phone: "+15550001111", treatment: "Cleaning" } });
  assert.equal(r.body.success, true);
  assert.equal(r.body.appointment_id, "appt-new");
  assert.equal(r.body.appointment.status, "Scheduled");
  assert.equal(r.body.appointment.date, "2099-01-10");
});

test("booking with a valid patient_id passes it through to the booking context", async () => {
  const { deps, calls } = makeDeps({ listUpcoming: async () => [] });
  const r = await call(deps, { tool: "book_appointment", args: { datetime: "2099-01-10T10:00", patient_id: "pat-1" } });
  assert.equal(r.body.success, true);
  assert.equal(calls.book[0].ctx.patientId, "pat-1");
});

test("booking with an unknown patient_id fails without booking", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "book_appointment", args: { datetime: "2099-01-10T10:00", patient_id: "pat-nope" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "patient_not_found");
  assert.equal(calls.book.length, 0);
});

test("duplicate booking at the same datetime is blocked before insert", async () => {
  const { deps, calls } = makeDeps(); // listUpcoming returns APPT_A at 2099-01-10 10:00
  const r = await call(deps, { tool: "book_appointment", args: { datetime: "2099-01-10T10:00", patient_id: "pat-1" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "duplicate_booking");
  assert.equal(r.body.appointment.appointment_id, "appt-aaa");
  assert.equal(calls.book.length, 0);
});

test("failed Pydent insert is reported as failure with a structured reason", async () => {
  const { deps } = makeDeps({
    listUpcoming: async () => [],
    book: async () => ({ success: false, error: "slot_taken", spoken: "That slot (2099-01-10 10:00) is already taken — offer the patient a different open time." }),
  });
  const r = await call(deps, { tool: "book_appointment", args: { datetime: "2099-01-10T10:00", name: "Pat" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "slot_taken");
  assert.equal("appointment_id" in r.body, false);
});

// ── list_upcoming_appointments ───────────────────────────────────────────────
test("lists all upcoming appointments for the resolved patient", async () => {
  const { deps } = makeDeps({ listUpcoming: async () => [APPT_A, APPT_B] });
  const r = await call(deps, { tool: "list_upcoming_appointments", args: { phone: "+15550001111" } });
  assert.equal(r.body.success, true);
  assert.equal(r.body.found, true);
  assert.equal(r.body.patient_id, "pat-1");
  assert.equal(r.body.appointments.length, 2);
  assert.deepEqual(Object.keys(r.body.appointments[0]).sort(), ["appointment_id", "date", "doctor", "service", "status", "time"]);
});

test("listing works with patient_id and reports an empty schedule truthfully", async () => {
  const { deps } = makeDeps({ listUpcoming: async () => [] });
  const r = await call(deps, { tool: "list_upcoming_appointments", args: { patient_id: "pat-1" } });
  assert.equal(r.body.found, false);
  assert.deepEqual(r.body.appointments, []);
});

test("listing without any patient reference is refused", async () => {
  const { deps } = makeDeps();
  const r = await call(deps, { tool: "list_upcoming_appointments", args: {} });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "patient_not_identified");
});

// ── Appointment targeting: reschedule / cancel ───────────────────────────────
test("manage refuses to act without patient identification", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: {} });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "patient_not_identified");
  assert.equal(calls.cancel.length, 0);
});

test("unknown patient → patient_not_found, nothing changed (never creates)", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { phone: "+19999999999" } });
  assert.equal(r.body.reason, "patient_not_found");
  assert.equal(calls.cancel.length, 0);
});

test("zero upcoming appointments → appointment_not_found with empty list", async () => {
  const { deps, calls } = makeDeps({ listUpcoming: async () => [] });
  const r = await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", datetime: "2099-01-11T10:00" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "appointment_not_found");
  assert.deepEqual(r.body.appointments, []);
  assert.equal(calls.reschedule.length, 0);
});

test("exactly one upcoming appointment → acted on, with its real Pydent id", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { phone: "+15550001111" } });
  assert.equal(r.body.success, true);
  assert.equal(r.body.appointment_id, "appt-aaa");
  assert.equal(calls.cancel[0].appt.id, "appt-aaa");
});

test("several upcoming appointments → ambiguous, choices returned, NOTHING modified", async () => {
  const { deps, calls } = makeDeps({ listUpcoming: async () => [APPT_A, APPT_B] });
  const r = await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", datetime: "2099-01-11T10:00" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "ambiguous_appointment");
  assert.equal(r.body.ambiguous, true);
  assert.equal(r.body.appointments.length, 2);
  assert.equal(r.body.appointments[0].appointment_id, "appt-aaa");
  assert.equal(calls.reschedule.length, 0);
});

test("explicit appointment_id: acts on EXACTLY that appointment", async () => {
  const { deps, calls } = makeDeps({ listUpcoming: async () => [APPT_A, APPT_B] });
  const r = await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", appointment_id: "appt-bbb", datetime: "2099-02-02T09:00" } });
  assert.equal(r.body.success, true);
  assert.equal(calls.reschedule[0].appt.id, "appt-bbb");
  assert.equal(calls.reschedule[0].dt, "2099-02-02T09:00");
  assert.equal(r.body.appointment.date, "2099-02-02");
});

test("manage accepts patient_id for identification", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { patient_id: "pat-1", appointment_id: "appt-aaa" } });
  assert.equal(r.body.success, true);
  assert.equal(calls.cancel[0].appt.id, "appt-aaa");
});

test("appointment belonging to a DIFFERENT patient → ownership mismatch, nothing changed", async () => {
  const { deps, calls } = makeDeps();
  for (const tool of ["cancel_appointment", "reschedule_appointment"]) {
    const r = await call(deps, { tool, args: { phone: "+15550001111", appointment_id: "appt-zzz", datetime: "2099-01-11T10:00" } });
    assert.equal(r.body.success, false);
    assert.equal(r.body.reason, "appointment_ownership_mismatch");
  }
  assert.equal(calls.cancel.length, 0);
  assert.equal(calls.reschedule.length, 0);
});

test("nonexistent appointment reference → not found, nothing changed", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "cancel_appointment", args: { phone: "+15550001111", appointment_id: "appt-nope" } });
  assert.equal(r.body.reason, "appointment_not_found");
  assert.equal(calls.cancel.length, 0);
});

test("reschedule without a valid datetime → 400 before any lookup", async () => {
  const { deps, calls } = makeDeps();
  const r = await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", datetime: "next tuesday" } });
  assert.equal(r.status, 400);
  assert.equal(calls.reschedule.length, 0);
});

// ── No Open Dental vocabulary in the contract ───────────────────────────────
test("responses never expose Open Dental vocabulary", async () => {
  const { deps } = makeDeps({ listUpcoming: async () => [APPT_A, APPT_B] });
  const bodies = [
    (await call(deps, {})).body,
    (await call(deps, { tool: "list_upcoming_appointments", args: { patient_id: "pat-1" } })).body,
    (await call(deps, { tool: "reschedule_appointment", args: { phone: "+15550001111", datetime: "2099-01-11T10:00" } })).body,
  ];
  for (const b of bodies) {
    const text = JSON.stringify(b);
    assert.equal(/apt_num|pat_num|prov_num|external_id|open ?dental/i.test(text), false, text);
  }
});

test("email result mirrors the actual send outcome", async () => {
  const failing = makeDeps({ sendEmail: async () => ({ sent: false, message: "Email isn't connected." }) });
  const r = await call(failing.deps, { tool: "send_email", args: { to: "x@example.com", subject: "s", body: "b" } });
  assert.equal(r.body.success, false);
  assert.equal(r.body.reason, "email_not_sent");
});

// ── Handler exceptions never leak internals ─────────────────────────────────
test("a throwing handler → generic 500, no internal message in the body", async () => {
  const { deps } = makeDeps({ getSlots: async () => { throw new Error("db row for patient Jane Doe failed"); } });
  const r = await call(deps, { tool: "get_available_slots", args: { date: "2099-01-10" } });
  assert.equal(r.status, 500);
  assert.equal(JSON.stringify(r.body).includes("Jane"), false);
});

// ── Unit checks on the pure helpers ─────────────────────────────────────────
test("resolveBuilderTool normalizes case and dashes", () => {
  assert.equal(resolveBuilderTool("Lookup-Patient", {}).canonical, "lookup_patient");
  assert.equal(resolveBuilderTool("", {}).ok, false);
});

test("builderToolEnabled: search_knowledge always on; switches respected", () => {
  assert.equal(builderToolEnabled({ ...AGENT, voice_settings: { tools: {} } }, "search_knowledge"), true);
  assert.equal(builderToolEnabled({ ...AGENT, voice_settings: {} }, "book_appointment"), true);
  assert.equal(builderToolEnabled({ ...AGENT, can_book: false, voice_settings: {} }, "book_appointment"), false);
  assert.equal(builderToolEnabled({ ...AGENT, voice_settings: { tools: { lookup_patient: false } } }, "list_upcoming_appointments"), false);
});
