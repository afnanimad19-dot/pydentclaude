// Smart Scheduling — Day 2: doctor→calendar mapping management, per-doctor
// timezone overrides, test-calendar labelling, and the read-only AI tool
// wiring into the Builder HTTP adapter and the WhatsApp tool list.
// All mocked (no network, no DB, fictional clinics and calendars).

import { test } from "node:test";
import assert from "node:assert/strict";

const { getClinicAvailability } = await import("@/lib/availability-server");
const { executeSchedulingTool } = await import("@/lib/scheduling-tools");
const { validateDoctorCalendar, upsertDoctorCalendar, removeDoctorCalendar } = await import("@/lib/doctor-calendars-server");
const { handleBuilderToolRequest, builderToolEnabled } = await import("@/lib/builder-tools");
const { AGENT_TOOLS, defaultToolState, normalizeVoiceSettings } = await import("@/lib/agent-config");
const { toolsFor } = await import("@/lib/agent-reply");

const TZ = "Asia/Dubai";
const DAY = "2026-10-30";
const WS = "11111111-1111-1111-1111-111111111111";
const OTHER_WS = "22222222-2222-2222-2222-222222222222";
const CAL_A = "cal-a@group.calendar.google.com";
const CAL_B = "cal-b@group.calendar.google.com";

const clinicConfig = {
  timezone: TZ,
  settings: { openTime: "08:00", closeTime: "21:00", slotMinutes: 5, defaultDurationMin: 30, closedDays: ["sunday"] },
};

function mockDeps(rows, overrides = {}) {
  return {
    configured: () => true,
    listDoctorCalendars: async (ws) => ({ ok: true, rows: ws === WS ? rows : [] }),
    getClinicConfig: async () => clinicConfig,
    freeBusy: async (q) => ({
      ok: true, status: 200, tookMs: 5,
      calendars: Object.fromEntries(q.calendarIds.map((id) => [id, { busy: [] }])),
    }),
    now: () => new Date("2026-10-01T06:00:00Z"),
    ...overrides,
  };
}

// ── Mapping validation (doctor-calendars-server) ─────────────────────────────

test("mapping: a valid row normalizes with defaults (google, active, not test)", () => {
  const r = validateDoctorCalendar({ doctor: "  Dr. Leila Hariri ", calendar_id: CAL_A });
  assert.equal(r.ok, true);
  assert.deepEqual(r.mapping, {
    doctor_name: "Dr. Leila Hariri", calendar_id: CAL_A, provider: "google",
    timezone: null, active: true, is_test: false,
  });
});

test("mapping: doctor name, calendar address, provider, and timezone are validated", () => {
  assert.equal(validateDoctorCalendar({ doctor: "", calendar_id: CAL_A }).ok, false);
  assert.equal(validateDoctorCalendar({ doctor: "X", calendar_id: CAL_A }).ok, false); // too short
  assert.equal(validateDoctorCalendar({ doctor: "Dr. A B", calendar_id: "not a calendar" }).ok, false);
  assert.equal(validateDoctorCalendar({ doctor: "Dr. A B", calendar_id: "has spaces@x.com " + "y" }).ok, false);
  assert.equal(validateDoctorCalendar({ doctor: "Dr. A B", calendar_id: CAL_A, provider: "outlook" }).ok, false);
  const badTz = validateDoctorCalendar({ doctor: "Dr. A B", calendar_id: CAL_A, timezone: "Mars/Olympus" });
  assert.equal(badTz.ok, false);
  assert.match(badTz.error, /IANA timezone/);
  const goodTz = validateDoctorCalendar({ doctor: "Dr. A B", calendar_id: CAL_A, timezone: "Europe/Berlin", is_test: true, active: false });
  assert.equal(goodTz.ok, true);
  assert.equal(goodTz.mapping.timezone, "Europe/Berlin");
  assert.equal(goodTz.mapping.is_test, true);
  assert.equal(goodTz.mapping.active, false);
});

test("mapping: upsert writes ONLY to the caller's workspace and never on invalid input", async () => {
  const writes = [];
  const deps = {
    upsert: async (ws, row) => { writes.push({ ws, row }); return { ok: true }; },
    remove: async () => ({ ok: true }),
  };
  const bad = await upsertDoctorCalendar(deps, WS, { doctor: "Dr. A B", calendar_id: "nope" });
  assert.equal(bad.ok, false);
  assert.equal(writes.length, 0, "invalid input must never reach persistence");

  const ok = await upsertDoctorCalendar(deps, WS, { doctor: "Dr. A B", calendar_id: CAL_A });
  assert.equal(ok.ok, true);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].ws, WS, "the verified session workspace is the only tenant key");
});

test("mapping: remove requires a doctor and passes the workspace through", async () => {
  const removed = [];
  const deps = { upsert: async () => ({ ok: true }), remove: async (ws, doctor, provider) => { removed.push({ ws, doctor, provider }); return { ok: true }; } };
  const bad = await removeDoctorCalendar(deps, WS, {});
  assert.equal(bad.ok, false);
  assert.equal(removed.length, 0);
  const ok = await removeDoctorCalendar(deps, WS, { doctor: "Dr. A B" });
  assert.equal(ok.ok, true);
  assert.deepEqual(removed[0], { ws: WS, doctor: "Dr. A B", provider: "google" });
});

// ── Per-doctor timezone override (migration 0066) ────────────────────────────

test("timezone override: slots are computed in the doctor's timezone; batch window covers every doctor", async () => {
  // 2026-10-30: Dubai is UTC+4 (08:00→04:00Z), Berlin is UTC+1 after the DST
  // fall-back (08:00→07:00Z). The ONE batched query must span 04:00Z–20:00Z or
  // Berlin busy intervals would be missed (= fabricated availability).
  const rows = [
    { doctor_name: "Dr. Leila Hariri", calendar_id: CAL_A, provider: "google", active: true },
    { doctor_name: "Dr. Remote Tele", calendar_id: CAL_B, provider: "google", active: true, timezone: "Europe/Berlin" },
  ];
  const calls = [];
  const deps = mockDeps(rows, {
    freeBusy: async (q) => {
      calls.push(q);
      return {
        ok: true, status: 200, tookMs: 5,
        calendars: {
          [CAL_A]: { busy: [] },
          // 07:00Z–07:30Z = 08:00–08:30 Berlin: the Berlin doctor's first slot moves.
          [CAL_B]: { busy: [{ start: `${DAY}T07:00:00Z`, end: `${DAY}T07:30:00Z` }] },
        },
      };
    },
  });
  const r = await getClinicAvailability(deps, WS, { date: DAY, durationMin: 30 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeMin, `${DAY}T04:00:00.000Z`);
  assert.equal(calls[0].timeMax, `${DAY}T20:00:00.000Z`);
  const leila = r.doctors.find((d) => d.doctor === "Dr. Leila Hariri");
  const remote = r.doctors.find((d) => d.doctor === "Dr. Remote Tele");
  assert.equal(leila.timezone, TZ);
  assert.equal(leila.slots[0].start, "08:00");
  assert.equal(remote.timezone, "Europe/Berlin");
  assert.equal(remote.slots[0].start, "08:30", "busy 08:00–08:30 Berlin excluded in the doctor's own timezone");
  assert.equal(remote.slots[remote.slots.length - 1].start, "20:30");
});

test("timezone override: an invalid stored timezone falls back to the clinic timezone", async () => {
  const rows = [{ doctor_name: "Dr. Leila Hariri", calendar_id: CAL_A, provider: "google", active: true, timezone: "Mars/Olympus" }];
  const r = await getClinicAvailability(mockDeps(rows), WS, { date: DAY });
  assert.equal(r.success, true);
  assert.equal(r.doctors[0].timezone, TZ);
  assert.equal(r.doctors[0].slots[0].start, "08:00");
});

// ── Test-calendar labelling ──────────────────────────────────────────────────

test("test calendars: availability is flagged per doctor and labelled in spoken output", async () => {
  const rows = [
    { doctor_name: "Dr. Leila Hariri", calendar_id: CAL_A, provider: "google", active: true, is_test: true },
    { doctor_name: "Dr. Omar Said", calendar_id: CAL_B, provider: "google", active: true },
  ];
  const out = await executeSchedulingTool(WS, "find_available_doctors", { date: DAY }, mockDeps(rows));
  const leila = out.structured.doctors.find((d) => d.doctor === "Dr. Leila Hariri");
  const omar = out.structured.doctors.find((d) => d.doctor === "Dr. Omar Said");
  assert.equal(leila.test, true);
  assert.equal(omar.test, undefined, "clinical mappings carry no test flag");
  assert.match(out.spoken, /TEST calendar/);
  assert.match(out.spoken, /not confirmed clinical availability/);

  const single = await executeSchedulingTool(WS, "check_doctor_availability", { doctor: "Leila", date: DAY }, mockDeps(rows));
  assert.match(single.spoken, /TEST calendar/);

  const clinicalOnly = await executeSchedulingTool(WS, "check_doctor_availability", { doctor: "Omar", date: DAY }, mockDeps(rows));
  assert.doesNotMatch(clinicalOnly.spoken, /TEST calendar/, "clinical availability is never labelled test");
});

// ── Per-agent opt-in (default OFF everywhere) ────────────────────────────────

test("agent config: the scheduling tools exist in the registry and default OFF", () => {
  for (const id of ["check_doctor_availability", "find_available_doctors"]) {
    assert.ok(AGENT_TOOLS.some((t) => t.id === id), `${id} is registered`);
    assert.equal(defaultToolState({ canBook: true, canReschedule: true, canCancel: true })[id], false, `${id} defaults OFF even for fully-enabled agents`);
    const normalized = normalizeVoiceSettings({}, { canBook: true, canReschedule: true, canCancel: true });
    assert.equal(normalized.tools[id], false, `${id} normalizes OFF for existing agents`);
    assert.equal(builderToolEnabled({ id: "a", name: "A", workspace_id: WS, can_book: true }, id), false);
    assert.equal(builderToolEnabled({ id: "a", name: "A", workspace_id: WS, voice_settings: { tools: { [id]: true } } }, id), true, `${id} turns on only by explicit config`);
  }
});

test("whatsapp tool list: scheduling tools are offered ONLY when the per-agent flags are on", () => {
  const off = toolsFor({ canBook: true, canReschedule: true, canCancel: true });
  assert.ok(!off.some((t) => t.function?.name === "check_doctor_availability"));
  assert.ok(!off.some((t) => t.function?.name === "find_available_doctors"));

  const on = toolsFor({ canCheckDoctorAvailability: true, canFindAvailableDoctors: true });
  assert.ok(on.some((t) => t.function?.name === "check_doctor_availability"));
  assert.ok(on.some((t) => t.function?.name === "find_available_doctors"));
  const check = on.find((t) => t.function?.name === "check_doctor_availability");
  assert.deepEqual(check.function.parameters.required, ["doctor", "date"]);
});

// ── Builder HTTP adapter (read-only tool execution) ──────────────────────────

const boom = (name) => async () => { throw new Error(`${name} must never run for a read-only scheduling tool`); };

function builderDeps(rows, overrides = {}) {
  return {
    resolveToken: async (token) => (token === "tok-ws1" ? { ok: true, ws: WS } : token === "tok-ws2" ? { ok: true, ws: OTHER_WS } : { ok: false }),
    getSlots: boom("getSlots"), book: boom("book"), findPatientId: boom("findPatientId"),
    getPatient: boom("getPatient"), listUpcoming: boom("listUpcoming"), findAppointment: boom("findAppointment"),
    rescheduleRow: boom("rescheduleRow"), cancelRow: boom("cancelRow"), lookupPatient: boom("lookupPatient"),
    createPatient: boom("createPatient"), searchKnowledge: boom("searchKnowledge"), sendEmail: boom("sendEmail"),
    executeScheduling: (ws, name, args) => executeSchedulingTool(ws, name, args, mockDeps(rows)),
    ...overrides,
  };
}

const schedulingAgent = (ws = WS) => ({
  id: "agent-1", name: "Laura", workspace_id: ws,
  voice_settings: { tools: { check_doctor_availability: true, find_available_doctors: true } },
});

const ROWS = [{ doctor_name: "Dr. Leila Hariri", calendar_id: CAL_A, provider: "google", active: true, is_test: true }];

test("builder adapter: scheduling tool runs read-only with the AGENT's workspace, never a caller-supplied one", async () => {
  const seenWs = [];
  const deps = builderDeps(ROWS, {
    executeScheduling: (ws, name, args) => { seenWs.push(ws); return executeSchedulingTool(ws, name, args, mockDeps(ROWS)); },
  });
  const r = await handleBuilderToolRequest(deps, {
    authHeader: "Bearer tok-ws1",
    agent: schedulingAgent(),
    tool: "check_doctor_availability",
    args: { doctor: "Dr. Leila Hariri", date: DAY, duration_min: 60, ws: OTHER_WS, workspace_id: OTHER_WS },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.deepEqual(seenWs, [WS], "tenant comes from the authenticated agent, not tool arguments");
  assert.equal(r.body.availability.durationMin, 60, "requested appointment duration is honoured");
  assert.equal(r.body.availability.doctors[0].test, true);
  assert.match(r.body.spoken, /TEST calendar/);
  // Read-only: no booking/patient dep was called (they all throw) and the
  // response carries no booking identifiers.
  assert.equal(r.body.appointment_id, undefined);
});

test("builder adapter: scheduling tools are DISABLED by default (403, nothing executed)", async () => {
  let executed = 0;
  const deps = builderDeps(ROWS, { executeScheduling: async () => { executed++; return { structured: {}, spoken: "" }; } });
  const agent = { id: "agent-1", name: "Laura", workspace_id: WS }; // no explicit opt-in
  for (const tool of ["check_doctor_availability", "find_available_doctors"]) {
    const r = await handleBuilderToolRequest(deps, { authHeader: "Bearer tok-ws1", agent, tool, args: { doctor: "x", date: DAY } });
    assert.equal(r.status, 403);
    assert.equal(r.body.reason, "tool_disabled");
  }
  assert.equal(executed, 0);
});

test("builder adapter: a token from another workspace cannot reach this agent's availability", async () => {
  const r = await handleBuilderToolRequest(builderDeps(ROWS), {
    authHeader: "Bearer tok-ws2",
    agent: schedulingAgent(),
    tool: "check_doctor_availability",
    args: { doctor: "Dr. Leila Hariri", date: DAY },
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, "forbidden_workspace");
});

test("builder adapter: missing mapping / failed calendar reads are reported, never guessed", async () => {
  // No mapping for the requested doctor.
  const noMapping = await handleBuilderToolRequest(builderDeps(ROWS), {
    authHeader: "Bearer tok-ws1", agent: schedulingAgent(), tool: "check_doctor_availability",
    args: { doctor: "Dr. Nobody", date: DAY },
  });
  assert.equal(noMapping.status, 200);
  assert.equal(noMapping.body.success, false);
  assert.equal(noMapping.body.reason, "no_mapping");

  // Upstream auth failure: no slots are ever offered.
  const authFail = await handleBuilderToolRequest(
    builderDeps(ROWS, {
      executeScheduling: (ws, name, args) =>
        executeSchedulingTool(ws, name, args, mockDeps(ROWS, { freeBusy: async () => ({ ok: false, status: 401, error: "auth_failed", detail: "invalid_grant" }) })),
    }),
    { authHeader: "Bearer tok-ws1", agent: schedulingAgent(), tool: "find_available_doctors", args: { date: DAY } }
  );
  assert.equal(authFail.body.success, false);
  assert.equal(authFail.body.reason, "auth_failed");
  assert.ok(authFail.body.availability.doctors.every((d) => d.slots.length === 0));
});
