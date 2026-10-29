// Smart Scheduling — tenant-scoped availability service + FreeBusy client +
// shared AI tool contracts, with mocked Google responses (no network, no DB,
// fictional clinics). Covers the Day-1 required scenarios that live above the
// pure math: API auth failure, calendar access denied, Google timeout, missing
// doctor mapping, workspace scoping, and multi-doctor batched FreeBusy.

import { test } from "node:test";
import assert from "node:assert/strict";

const { getClinicAvailability, getDoctorAvailability } = await import("@/lib/availability-server");
const { freeBusyQuery, FREEBUSY_BATCH } = await import("@/lib/google-freebusy");
const { executeSchedulingTool, SCHEDULING_TOOL_CONTRACTS } = await import("@/lib/scheduling-tools");

const TZ = "Asia/Dubai";
const DAY = "2026-10-30";
const WS = "11111111-1111-1111-1111-111111111111";
const CAL_A = "cal-a@group.calendar.google.com";
const CAL_B = "cal-b@group.calendar.google.com";

const clinicConfig = {
  timezone: TZ,
  settings: { openTime: "08:00", closeTime: "21:00", slotMinutes: 5, defaultDurationMin: 30, closedDays: ["sunday"] },
};

function mockDeps(overrides = {}) {
  return {
    configured: () => true,
    listDoctorCalendars: async (ws) => ({
      ok: true,
      rows: ws === WS
        ? [
            { doctor_name: "Dr. Leila Hariri", calendar_id: CAL_A, provider: "google", active: true },
            { doctor_name: "Dr. Omar Said", calendar_id: CAL_B, provider: "google", active: true },
          ]
        : [], // any other workspace sees nothing
    }),
    getClinicConfig: async () => clinicConfig,
    freeBusy: async (q) => ({
      ok: true, status: 200, tookMs: 5,
      calendars: Object.fromEntries(q.calendarIds.map((id) => [id, { busy: [] }])),
    }),
    now: () => new Date("2026-10-01T06:00:00Z"),
    ...overrides,
  };
}

// ── Happy path + multi-doctor batching ───────────────────────────────────────
test("clinic availability queries ALL mapped calendars in ONE FreeBusy call", async () => {
  const calls = [];
  const deps = mockDeps({
    freeBusy: async (q) => {
      calls.push(q);
      return {
        ok: true, status: 200, tookMs: 5,
        calendars: {
          [CAL_A]: { busy: [{ start: `${DAY}T04:00:00Z`, end: `${DAY}T16:55:00Z` }] }, // 08:00–20:55 Dubai
          [CAL_B]: { busy: [] },
        },
      };
    },
  });
  const r = await getClinicAvailability(deps, WS, { date: DAY, durationMin: 30 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].calendarIds, [CAL_A, CAL_B]);
  assert.equal(r.success, true);
  assert.equal(r.timezone, TZ);
  assert.equal(r.source, "google_freebusy");
  const leila = r.doctors.find((d) => d.doctor === "Dr. Leila Hariri");
  const omar = r.doctors.find((d) => d.doctor === "Dr. Omar Said");
  assert.deepEqual(leila.slots, []); // 20:55–21:00 leaves no room for 30 min
  assert.equal(leila.busyCount, 1);
  assert.equal(omar.slots[0].start, "08:00");
  assert.equal(omar.slots[omar.slots.length - 1].start, "20:30");
});

test("doctor filter matches loosely (same rule as booked-appointment providers)", async () => {
  const r = await getClinicAvailability(mockDeps(), WS, { date: DAY, doctors: ["leila hariri"] });
  assert.equal(r.doctors.length, 1);
  assert.equal(r.doctors[0].doctor, "Dr. Leila Hariri");
});

// ── Failure semantics: never offer slots you cannot verify ──────────────────────
test("Google auth failure marks every doctor unavailable with zero slots", async () => {
  const deps = mockDeps({ freeBusy: async () => ({ ok: false, status: 401, error: "auth_failed", calendars: {}, tookMs: 3 }) });
  const r = await getClinicAvailability(deps, WS, { date: DAY });
  assert.equal(r.success, false);
  assert.equal(r.error, "auth_failed");
  assert.ok(r.doctors.every((d) => d.status === "unavailable" && d.slots.length === 0));
});

test("Google timeout is reported as timeout, not as an empty calendar", async () => {
  const deps = mockDeps({ freeBusy: async () => ({ ok: false, status: 0, error: "timeout", calendars: {}, tookMs: 10000 }) });
  const r = await getClinicAvailability(deps, WS, { date: DAY });
  assert.equal(r.success, false);
  assert.equal(r.error, "timeout");
});

test("one calendar with accessDenied fails ONLY that doctor", async () => {
  const deps = mockDeps({
    freeBusy: async (q) => ({
      ok: true, status: 200, tookMs: 5,
      calendars: {
        [CAL_A]: { busy: [], errors: [{ reason: "notFound" }] },
        [CAL_B]: { busy: [] },
      },
    }),
  });
  const r = await getClinicAvailability(deps, WS, { date: DAY });
  assert.equal(r.success, true); // one doctor still answered
  const leila = r.doctors.find((d) => d.doctor === "Dr. Leila Hariri");
  const omar = r.doctors.find((d) => d.doctor === "Dr. Omar Said");
  assert.equal(leila.status, "unavailable");
  assert.equal(leila.error, "calendar_error");
  assert.deepEqual(leila.slots, []);
  assert.equal(omar.status, "ok");
});

test("missing service-account config reports not_configured without calling Google", async () => {
  let called = false;
  const deps = mockDeps({ configured: () => false, freeBusy: async () => { called = true; throw new Error("must not be called"); } });
  const r = await getClinicAvailability(deps, WS, { date: DAY });
  assert.equal(called, false);
  assert.equal(r.success, false);
  assert.equal(r.error, "not_configured");
});

test("missing doctor-calendar mapping reports no_mapping", async () => {
  const r = await getClinicAvailability(mockDeps(), WS, { date: DAY, doctors: ["Dr. Nobody"] });
  assert.equal(r.success, false);
  assert.equal(r.error, "no_mapping");
  const r2 = await getDoctorAvailability(mockDeps(), WS, { doctor: "Dr. Nobody", date: DAY });
  assert.equal(r2.success, false);
  assert.equal(r2.error, "no_mapping");
});

test("cross-tenant scoping: another workspace sees no LHDM calendars", async () => {
  const r = await getClinicAvailability(mockDeps(), "22222222-2222-2222-2222-222222222222", { date: DAY });
  assert.equal(r.success, false);
  assert.equal(r.error, "no_mapping");
  assert.deepEqual(r.doctors, []);
});

test("closed weekday returns status closed (known-empty), not an error", async () => {
  const r = await getClinicAvailability(mockDeps(), WS, { date: "2026-11-01" }); // a Sunday
  assert.equal(r.success, true);
  assert.ok(r.doctors.every((d) => d.status === "closed" && d.slots.length === 0));
});

test("invalid date is rejected before any network call", async () => {
  const r = await getClinicAvailability(mockDeps(), WS, { date: "tomorrow" });
  assert.equal(r.error, "invalid_date");
});

test("for today, start times already in the past are not offered", async () => {
  // Clinic-local now = 2026-10-30 12:03 (+04). Next grid start: 12:05.
  const deps = mockDeps({ now: () => new Date("2026-10-30T08:03:00Z") });
  const r = await getClinicAvailability(deps, WS, { date: DAY });
  assert.equal(r.doctors[0].slots[0].start, "12:05");
});

// ── Date ranges ────────────────────────────────────────────────────────────────
test("doctor availability over a range returns one result per day", async () => {
  const r = await getDoctorAvailability(mockDeps(), WS, { doctor: "Dr. Leila Hariri", date: DAY, dateEnd: "2026-11-01" });
  assert.equal(r.days.length, 3);
  assert.equal(r.days[2].doctors[0].status, "closed"); // the Sunday
});

// ── FreeBusy client (mocked fetch; no real Google) ───────────────────────────────
const token = async () => ({ token: "test-token" });

test("freeBusyQuery batches calendars within the per-request limit", async () => {
  const ids = Array.from({ length: FREEBUSY_BATCH + 3 }, (_, i) => `c${i}@group.calendar.google.com`);
  const bodies = [];
  const fetchImpl = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ calendars: Object.fromEntries(JSON.parse(init.body).items.map((x) => [x.id, { busy: [] }])) }), { status: 200 });
  };
  const r = await freeBusyQuery({ timeMin: "2026-10-30T04:00:00Z", timeMax: "2026-10-30T17:00:00Z", timeZone: TZ, calendarIds: ids }, { fetchImpl, getToken: token });
  assert.equal(r.ok, true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].items.length, FREEBUSY_BATCH);
  assert.equal(bodies[1].items.length, 3);
  assert.equal(Object.keys(r.calendars).length, ids.length);
});

test("freeBusyQuery HTTP 403 reads as auth_failed, HTTP 500 as api_error", async () => {
  const mk = (status) => async () => new Response(JSON.stringify({ error: { message: "boom" } }), { status });
  const q = { timeMin: "2026-10-30T04:00:00Z", timeMax: "2026-10-30T17:00:00Z", timeZone: TZ, calendarIds: ["x@test"] };
  assert.equal((await freeBusyQuery(q, { fetchImpl: mk(403), getToken: token })).error, "auth_failed");
  assert.equal((await freeBusyQuery(q, { fetchImpl: mk(500), getToken: token })).error, "api_error");
});

test("freeBusyQuery timeout aborts and reports timeout", async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const r = await freeBusyQuery(
    { timeMin: "2026-10-30T04:00:00Z", timeMax: "2026-10-30T17:00:00Z", timeZone: TZ, calendarIds: ["x@test"] },
    { fetchImpl, getToken: token, timeoutMs: 10 }
  );
  assert.equal(r.ok, false);
  assert.equal(r.error, "timeout");
});

test("freeBusyQuery without credentials never calls Google", async () => {
  let called = false;
  const r = await freeBusyQuery(
    { timeMin: "t", timeMax: "t", timeZone: TZ, calendarIds: ["x@test"] },
    { fetchImpl: async () => { called = true; return new Response("{}"); }, getToken: async () => ({ error: "not_configured" }) }
  );
  assert.equal(called, false);
  assert.equal(r.error, "not_configured");
});

// ── Shared AI tool contracts ─────────────────────────────────────────────────
test("tool contracts cover both channels' tools with JSON-schema parameters", () => {
  const names = SCHEDULING_TOOL_CONTRACTS.map((t) => t.name);
  assert.deepEqual(names, ["check_doctor_availability", "find_available_doctors"]);
  for (const t of SCHEDULING_TOOL_CONTRACTS) {
    assert.equal(t.parameters.type, "object");
    assert.ok(t.parameters.required.includes("date"));
  }
});

test("check_doctor_availability speaks real slots and never invents them on failure", async () => {
  const ok = await executeSchedulingTool(WS, "check_doctor_availability", { doctor: "Dr. Leila Hariri", date: DAY }, mockDeps());
  assert.match(ok.spoken, /Dr\. Leila Hariri is available on 2026-10-30 at: 08:00/);
  assert.equal(ok.structured.success, true);

  const down = await executeSchedulingTool(
    WS, "check_doctor_availability", { doctor: "Dr. Leila Hariri", date: DAY },
    mockDeps({ freeBusy: async () => ({ ok: false, status: 0, error: "timeout", calendars: {}, tookMs: 1 }) })
  );
  assert.equal(down.structured.success, false);
  assert.doesNotMatch(down.spoken, /\d{2}:\d{2}/); // no times offered
  assert.match(down.spoken, /won't guess/);
});

test("find_available_doctors lists open doctors and flags unverifiable ones", async () => {
  const deps = mockDeps({
    freeBusy: async () => ({
      ok: true, status: 200, tookMs: 4,
      calendars: { [CAL_A]: { busy: [] }, [CAL_B]: { busy: [], errors: [{ reason: "accessDenied" }] } },
    }),
  });
  const out = await executeSchedulingTool(WS, "find_available_doctors", { date: DAY }, deps);
  assert.match(out.spoken, /Dr\. Leila Hariri at 08:00/);
  assert.match(out.spoken, /Could not verify: Dr\. Omar Said/);
});
