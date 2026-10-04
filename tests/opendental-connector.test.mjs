// M1D-A OpenDentalBookingConnector: real registry resolution, honest
// capability matrix, context guards, DTO + error translation over an
// injected fake gateway, secret-free errors, and proof that no production
// caller touches the new module. Deterministic, fictional data — no live
// Open Dental, no Supabase, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const { createOpenDentalConnector, OPENDENTAL_CAPABILITIES, odDoctorToConnectorProvider, odSlotsToAvailability, createInputToOdBody, scrubUpstreamDetail } =
  await import("@/lib/booking-connectors/opendental");
const { resolveBookingConnector } = await import("@/lib/booking-connectors/registry");
const { NO_CAPABILITIES } = await import("@/lib/booking-connectors/types");

const CTX = { workspaceId: "ws-fict-A", connectionId: "conn-fict-1" };

function fictConnection(overrides = {}) {
  return {
    id: "conn-fict-1", workspaceId: "ws-fict-A", connectorType: "opendental", displayName: "Fict",
    enabled: true, isPrimary: true, config: {}, lastSyncAt: null, syncStatus: null, lastError: null,
    createdAt: "", updatedAt: "", ...overrides,
  };
}

// A recording fake of the EXISTING gateway seam: returns queued responses and
// captures every (path, body) it was asked to forward. Fictional config with
// a decoy secret that must never surface in errors.
function fakeDeps(responses) {
  const calls = [];
  const queue = [...responses];
  return {
    calls,
    forward: async (ws, path, init) => {
      calls.push({ ws, path, method: init?.method, body: init?.body ?? null });
      return queue.shift() ?? { status: 500, data: { error: "fake queue empty" } };
    },
    getConfig: async () => ({ url: "https://fict.example", key: "sk-fict-SECRET-999", developerKey: "dk-fict-SECRET-111", username: "", password: "", enabled: true }),
  };
}

// ── 1–3. Registry resolution ────────────────────────────────────────────────
test("opendental resolves to the real adapter; d4w and pydent_native stay placeholders", () => {
  const od = resolveBookingConnector(fictConnection(), CTX);
  assert.equal(od.ok, true);
  assert.equal(od.resolved.connector.getCapabilities().providers, true, "real adapter declares real capabilities");
  for (const type of ["d4w", "pydent_native"]) {
    const r = resolveBookingConnector(fictConnection({ connectorType: type }), CTX);
    assert.equal(r.ok, true);
    assert.deepEqual(r.resolved.connector.getCapabilities(), NO_CAPABILITIES, `${type} must remain a zero-capability placeholder`);
  }
});

// ── 4/16. Capabilities match implementation; unsupported ops fail honestly ──
test("capability matrix matches reality: false capabilities return unsupported_capability", async () => {
  assert.deepEqual(OPENDENTAL_CAPABILITIES, {
    providers: true, schedules: false, operatories: false, appointments: false,
    availability: true, createAppointment: true, updateAppointment: true, cancelAppointment: true, sync: false,
    findPatients: true, createPatient: true, findAppointments: true,
  });
  const c = createOpenDentalConnector(fakeDeps([]));
  for (const out of await Promise.all([
    c.getSchedules(CTX, { dateFrom: "2099-01-01", dateTo: "2099-01-07" }),
    c.getOperatories(CTX),
    c.getAppointments(CTX, { dateFrom: "2099-01-01", dateTo: "2099-01-07" }),
    c.sync(CTX, { syncType: "initial_import" }),
  ])) {
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "unsupported_capability");
  }
});

// ── 5/6. Context is required on every operation ─────────────────────────────
test("missing workspace or connection context fails closed on every method", async () => {
  const c = createOpenDentalConnector(fakeDeps([]));
  for (const ctx of [null, {}, { workspaceId: "ws-fict-A" }, { connectionId: "conn-fict-1" }]) {
    for (const out of await Promise.all([
      c.testConnection(ctx),
      c.getProviders(ctx),
      c.getAvailability(ctx, { date: "2099-01-10" }),
      c.createAppointment(ctx, { patient: { name: "Fict" }, service: "Cleaning", date: "2099-01-10", time: "10:00", durationMin: 30 }),
      c.updateAppointment(ctx, { appointment: { externalId: "1" }, date: "2099-01-11", time: "11:00" }),
      c.cancelAppointment(ctx, { externalId: "1" }),
    ])) {
      assert.equal(out.ok, false);
      assert.equal(out.error.code, "invalid_request");
    }
  }
});

// ── 7/13. Provider translation, no OD field names in generic DTOs ───────────
test("gateway doctors translate to generic providers with opaque externalId", async () => {
  const deps = fakeDeps([{ status: 200, data: { doctors: [{ id: 12, name: "Dr Fictional", specialty: "Ortho" }, { id: "15", name: "Dr Example" }] } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.getProviders(CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data[0], { pydentProviderId: null, externalId: "12", name: "Dr Fictional", specialty: "Ortho", bookingEnabled: true });
  assert.equal(r.data[1].externalId, "15");
  const json = JSON.stringify(r.data);
  for (const odField of ["ProvNum", "PatNum", "AptNum", "OpNum", "ScheduleNum"]) {
    assert.equal(json.includes(odField), false, `generic DTO must not carry ${odField}`);
  }
  assert.deepEqual(deps.calls[0], { ws: "ws-fict-A", path: "/doctors", method: "GET", body: null });
});

// ── 8. Availability translation ─────────────────────────────────────────────
test("gateway slots translate to generic availability slots", async () => {
  const deps = fakeDeps([{ status: 200, data: { slots: ["09:00", "10:30", "junk"] } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.getAvailability(CTX, { date: "2099-01-10", provider: { externalId: "12" }, service: "cleaning", durationMin: 45 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data[0], { date: "2099-01-10", time: "09:00", durationMin: 45, provider: { externalId: "12" }, operatory: null });
  assert.equal(r.data.length, 2); // malformed times dropped
  assert.deepEqual(deps.calls[0].body, { doctorId: "12", serviceId: "cleaning", date: "2099-01-10" });
  // A provider with only a Pydent id is never fuzzy-matched or guessed:
  const noMap = await c.getAvailability(CTX, { date: "2099-01-10", provider: { pydentId: "prov-fict-1" } });
  assert.equal(noMap.ok, false);
  assert.equal(noMap.error.code, "provider_not_found");
});

// ── 9/10. Create translation (M1E-C-C: established patient identity only) ──
test("create transmits the ESTABLISHED patient identity and mapped service id; missing externalId fails", async () => {
  assert.deepEqual(
    createInputToOdBody({ patient: { externalId: "301", name: "Fictional Patient", phone: "+971500000001", email: "f@example.test" }, provider: { externalId: "12" }, service: "Cleaning", serviceExternalId: "D1110-ext", date: "2099-01-10", time: "10:00", durationMin: 30 }),
    { name: "Fictional Patient", phone: "+971500000001", email: "f@example.test", patientExternalId: "301", patNum: "301", doctorId: "12", serviceId: "D1110-ext", datetime: "2099-01-10T10:00", consent: true }
  );
  const deps = fakeDeps([{ status: 200, data: { appointmentId: 987 } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.createAppointment(CTX, { patient: { externalId: "301", name: "Fictional Patient" }, provider: { externalId: "12" }, service: "", serviceExternalId: "D1110-ext", date: "2099-01-10", time: "10:00", durationMin: 30 });
  assert.equal(r.ok, true);
  assert.equal(r.data.externalId, "987");
  assert.equal(r.data.status, "Scheduled");
  // The gateway has no duration parameter, so the external appointment's
  // duration is unknown — the result must say null, never echo the request.
  assert.equal(r.data.durationMin, null);
  assert.equal(deps.calls[0].body.patientExternalId, "301");
  // Without an established external patient identity, create refuses — the
  // connector path never finds-or-creates a patient:
  const noExt = await c.createAppointment(CTX, { patient: { name: "Fictional", phone: "+971500000001" }, service: "Cleaning", date: "2099-01-10", time: "10:00", durationMin: 30 });
  assert.equal(noExt.ok, false);
  assert.equal(noExt.error.code, "invalid_request");
  assert.match(noExt.error.message, /establish/i);
  assert.deepEqual(fakeDeps([]).calls, []);
  // A 409 from the strict slot branch maps to slot_unavailable:
  const stale = createOpenDentalConnector(fakeDeps([{ status: 409, data: { error: "The requested slot is no longer available." } }]));
  const s = await stale.createAppointment(CTX, { patient: { externalId: "301" }, service: "", serviceExternalId: "D1110-ext", date: "2099-01-10", time: "10:00", durationMin: 30 });
  assert.equal(s.error.code, "slot_unavailable");
});

test("gateway source: explicit-patient branch skips find-or-create, no first-slot/Op:1 fallback; legacy branch intact", async () => {
  const gw = await readFile(new URL("../src/lib/opendental-gateway.ts", import.meta.url), "utf8");
  const explicitStart = gw.indexOf("const explicitPat");
  const legacyStart = gw.indexOf("const patNum = await odApiFindOrCreatePatient");
  assert.ok(explicitStart > -1 && legacyStart > explicitStart, "explicit branch precedes the untouched legacy branch");
  const explicitBlock = gw.slice(explicitStart, legacyStart);
  assert.equal(explicitBlock.includes("odApiFindOrCreatePatient"), false, "explicit identity must skip find-or-create entirely");
  assert.equal(explicitBlock.includes("?? list[0]"), false, "no first-slot fallback on the connector branch");
  assert.equal(explicitBlock.includes("?? 1"), false, "no Op:1 fallback on the connector branch");
  assert.match(explicitBlock, /status: 409/);
  // Legacy branch keeps its historical behavior, verbatim markers:
  const legacyBlock = gw.slice(legacyStart);
  assert.match(legacyBlock, /\?\? list\[0\]/);
  assert.match(legacyBlock, /hit\?\.OpNum \?\? 1/);
});

test("findAppointments probe returns every row with opaque ids; middleware mode honestly unsupported", async () => {
  const deps = fakeDeps([{ status: 200, data: { appointments: [{ id: 501, dateTime: "2099-01-10 10:00:00" }, { id: 502, dateTime: "2099-01-10 15:00:00" }] } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.findAppointments(CTX, { patient: { externalId: "301" }, date: "2099-01-10" });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, [
    { externalId: "501", date: "2099-01-10", time: "10:00" },
    { externalId: "502", date: "2099-01-10", time: "15:00" },
  ]);
  assert.deepEqual(deps.calls[0].body, { patientExternalId: "301", date: "2099-01-10" });
  assert.equal(JSON.stringify(r.data).includes("AptNum"), false);
  const noPat = await c.findAppointments(CTX, { patient: {}, date: "2099-01-10" });
  assert.equal(noPat.error.code, "invalid_request");
  const mw = createOpenDentalConnector(fakeDeps([{ status: 404, data: {} }]));
  assert.equal((await mw.findAppointments(CTX, { patient: { externalId: "301" }, date: "2099-01-10" })).error.code, "unsupported_capability");
});

// ── 11. Update/reschedule translation ───────────────────────────────────────
test("reschedule supports date/time only, by external identity", async () => {
  const deps = fakeDeps([{ status: 200, data: { ok: true } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.updateAppointment(CTX, { appointment: { externalId: "987", pydentId: "appt-fict-1" }, date: "2099-01-11", time: "11:30" });
  assert.equal(r.ok, true);
  assert.deepEqual(deps.calls[0].body, { appointmentId: "987", datetime: "2099-01-11T11:30" });
  assert.equal(r.data.pydentAppointmentId, "appt-fict-1");
  // OD reports no duration on a reschedule — null, never 0/30/60 or any
  // fabricated default.
  assert.equal(r.data.durationMin, null);
  assert.equal(typeof r.data.durationMin === "number", false);

  const unmapped = await c.updateAppointment(CTX, { appointment: { pydentId: "appt-fict-2" }, date: "2099-01-11", time: "11:30" });
  assert.equal(unmapped.error.code, "appointment_not_found");
  const wide = await c.updateAppointment(CTX, { appointment: { externalId: "987" }, date: "2099-01-11", time: "11:30", durationMin: 60 });
  assert.equal(wide.error.code, "unsupported_capability");
  const noTime = await c.updateAppointment(CTX, { appointment: { externalId: "987" }, date: "2099-01-11" });
  assert.equal(noTime.error.code, "invalid_request");
});

// ── 12. Cancellation translation ────────────────────────────────────────────
test("cancel goes to the gateway by external identity", async () => {
  const deps = fakeDeps([{ status: 200, data: { ok: true } }, { status: 404, data: { error: "no such appointment" } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.cancelAppointment(CTX, { externalId: "987" });
  assert.deepEqual(r, { ok: true, data: { cancelled: true } });
  assert.deepEqual(deps.calls[0].body, { appointmentId: "987" });
  const gone = await c.cancelAppointment(CTX, { externalId: "988" });
  assert.equal(gone.error.code, "appointment_not_found");
  const unmapped = await c.cancelAppointment(CTX, { pydentId: "appt-fict-3" });
  assert.equal(unmapped.error.code, "appointment_not_found");
});

// ── M1E-C-B: patient search/create translation ──────────────────────────────
test("findPatients returns ALL candidates with opaque ids — no first-result selection, no PatNum", async () => {
  const deps = fakeDeps([{ status: 200, data: { patients: [
    { id: 301, name: "Fictional One", phone: "0500000001", email: "one@example.test" },
    { id: 302, name: "Fictional Two", phone: "0500000001", email: "" },
  ] } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.findPatients(CTX, { phone: "+971 50 000 0001" });
  assert.equal(r.ok, true);
  assert.equal(r.data.length, 2, "every candidate must be returned — selection is never the adapter's");
  assert.deepEqual(r.data[0], { pydentPatientId: null, externalId: "301", name: "Fictional One", phone: "0500000001", email: "one@example.test" });
  const json = JSON.stringify(r.data);
  for (const od of ["PatNum", "FName", "LName", "WirelessPhone"]) assert.equal(json.includes(od), false, `no ${od} may cross the boundary`);
  assert.deepEqual(deps.calls[0], { ws: "ws-fict-A", path: "/find-patients", method: "POST", body: { phone: "971500000001", email: "" } });
  // Phone is required evidence; middleware mode (404) reports honestly:
  const short = await c.findPatients(CTX, { phone: "123" });
  assert.equal(short.error.code, "invalid_request");
  const mw = createOpenDentalConnector(fakeDeps([{ status: 404, data: {} }]));
  assert.equal((await mw.findPatients(CTX, { phone: "0500000001" })).error.code, "unsupported_capability");
});

test("createPatient translates to the gateway and returns an opaque externalId", async () => {
  const deps = fakeDeps([{ status: 200, data: { patientId: 909 } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.createPatient(CTX, { name: "Fictional Patient", phone: "+971500000002", email: "f2@example.test" });
  assert.deepEqual(r, { ok: true, data: { externalId: "909" } });
  assert.equal(deps.calls[0].path, "/create-patient");
  assert.equal((await c.createPatient(CTX, {})).error.code, "invalid_request");
  const mw = createOpenDentalConnector(fakeDeps([{ status: 404, data: {} }]));
  assert.equal((await mw.createPatient(CTX, { name: "X", phone: "0500000003" })).error.code, "unsupported_capability");
});

// ── 14. Error translation ───────────────────────────────────────────────────
test("gateway failures map onto generic connector error codes", async () => {
  const cases = [
    [{ status: 401, data: { error: "rejected the keys" } }, "auth_failed"],
    [{ status: 400, data: { error: "Open Dental is not connected for this clinic." } }, "config_missing"],
    [{ status: 400, data: { error: "Open Dental connection is turned off." } }, "unavailable"],
    [{ status: 502, data: { error: "connection refused at fict.example" } }, "unavailable"],
    [{ status: 500, data: { error: "boom" } }, "external_error"],
  ];
  for (const [resp, code] of cases) {
    const c = createOpenDentalConnector(fakeDeps([resp]));
    const r = await c.getProviders(CTX);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, code, `HTTP ${resp.status} → ${code}`);
  }
});

// ── 15. No credential can appear in errors ──────────────────────────────────
test("errors never contain config values or authorization fragments", async () => {
  assert.equal(scrubUpstreamDetail("failed sending ODFHIR dk-fict-111/ck-fict-222 header"), "failed sending ODFHIR [redacted] header");
  // Even a hostile upstream error that echoes credentials is scrubbed/bounded,
  // and auth failures use a fixed message with no upstream text at all.
  const leakyAuth = createOpenDentalConnector(fakeDeps([{ status: 401, data: { error: "bad key sk-fict-SECRET-999" } }]));
  const a = await leakyAuth.getProviders(CTX);
  assert.equal(JSON.stringify(a.error).includes("sk-fict-SECRET-999"), false);
  const leaky500 = createOpenDentalConnector(fakeDeps([{ status: 500, data: { error: "denied for ODFHIR dk-fict-SECRET-111/sk-fict-SECRET-999" } }]));
  const b = await leaky500.getProviders(CTX);
  assert.equal(JSON.stringify(b.error).includes("SECRET"), false);
});

// ── testConnection is read-only and honest ──────────────────────────────────
test("testConnection checks config then a read-only health call — no writes", async () => {
  const deps = fakeDeps([{ status: 200, data: { ok: true } }]);
  const c = createOpenDentalConnector(deps);
  const r = await c.testConnection(CTX);
  assert.equal(r.ok, true);
  assert.deepEqual(deps.calls, [{ ws: "ws-fict-A", path: "/health", method: "GET", body: null }]);
  const noCfg = createOpenDentalConnector({ ...fakeDeps([]), getConfig: async () => null });
  assert.equal((await noCfg.testConnection(CTX)).error.code, "config_missing");
  const disabled = createOpenDentalConnector({ ...fakeDeps([]), getConfig: async () => ({ url: "https://fict.example", key: "", developerKey: "", username: "", password: "", enabled: false }) });
  assert.equal((await disabled.testConnection(CTX)).error.code, "unavailable");
});

// ── Duration contract: required on create input, nullable on results ────────
test("contract keeps create-input duration required while results may be honestly null", async () => {
  const src = await readFile(new URL("../src/lib/booking-connectors/types.ts", import.meta.url), "utf8");
  // CreateConnectorAppointmentInput still REQUIRES a number:
  const createBlock = src.slice(src.indexOf("interface CreateConnectorAppointmentInput"));
  assert.match(createBlock.slice(0, createBlock.indexOf("}")), /durationMin: number;/);
  // ConnectorAppointment results may report the external system's silence:
  const apptBlock = src.slice(src.indexOf("interface ConnectorAppointment {"));
  assert.match(apptBlock.slice(0, apptBlock.indexOf("}")), /durationMin: number \| null;/);
  // Availability slots keep carrying the REQUESTED duration (it comes from
  // the availability request, not from Open Dental) — unchanged by design.
  const slots = odSlotsToAvailability(["09:00"], { date: "2099-01-10", durationMin: 45 });
  assert.equal(slots[0].durationMin, 45);
  assert.equal(odSlotsToAvailability(["09:00"], { date: "2099-01-10" })[0].durationMin, null);
});

// ── 17. No production caller imports the new module ─────────────────────────
test("no production code outside booking-connectors imports the adapter or registry", async () => {
  const offenders = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (p.includes("booking-connectors") || e.name === "node_modules") continue;
        await walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        const src = await readFile(p, "utf8");
        if (src.includes("booking-connectors")) offenders.push(p);
      }
    }
  }
  await walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(offenders, [], "no production file may import booking-connectors yet (M1D-B wires adoption)");
});
