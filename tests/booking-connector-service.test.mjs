// M1D-B booking connector service: fail-closed resolution, capability
// gating, mapping-only identity (no name/first-anything fallback), honest
// create unavailability, and isolation from production callers. All deps
// injected — fictional data, no Supabase, no Open Dental, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const {
  connectorAvailability, connectorCreateAppointment, connectorReschedule, connectorCancel,
  resolveProviderExternalId, resolveServiceForConnection,
  resolvePatientForConnection, establishPatientMapping, establishPatientByCreation,
  reconcileAppointmentCreate,
} = await import("@/lib/booking-connectors/service");
const { getPrimaryBookingConnector } = await import("@/lib/booking-connectors/registry");
const { NO_CAPABILITIES } = await import("@/lib/booking-connectors/types");

const WS = "ws-fict-A";

function fictConnection(overrides = {}) {
  return {
    id: "conn-fict-1", workspaceId: WS, connectorType: "opendental", displayName: "Fict",
    enabled: true, isPrimary: true, config: { hint: "sk-fict-SECRET-999" }, lastSyncAt: null,
    syncStatus: null, lastError: null, createdAt: "", updatedAt: "", ...overrides,
  };
}

// A recording fake connector with controllable capabilities — stands in for
// the resolved implementation so invocation (or its absence) is observable.
function fakeConnector(caps, results = {}) {
  const calls = [];
  const op = (name, dflt) => async (...args) => { calls.push({ name, args }); return results[name] ?? dflt; };
  return {
    calls,
    connector: {
      type: "opendental",
      getCapabilities: () => ({ ...NO_CAPABILITIES, ...caps }),
      testConnection: op("testConnection", { ok: true, data: { reachable: true, authenticated: true } }),
      getProviders: op("getProviders", { ok: true, data: [] }),
      getSchedules: op("getSchedules", { ok: true, data: [] }),
      getOperatories: op("getOperatories", { ok: true, data: [] }),
      getAppointments: op("getAppointments", { ok: true, data: [] }),
      getAvailability: op("getAvailability", { ok: true, data: [{ date: "2099-01-10", time: "09:00", durationMin: null, provider: null, operatory: null }] }),
      findPatients: op("findPatients", { ok: true, data: [] }),
      createPatient: op("createPatient", { ok: true, data: { externalId: "ext-pat-new" } }),
      findAppointments: op("findAppointments", { ok: true, data: [] }),
      createAppointment: op("createAppointment", { ok: true, data: {} }),
      updateAppointment: op("updateAppointment", { ok: true, data: { externalId: "987", date: "2099-01-11", time: "11:00", durationMin: null } }),
      cancelAppointment: op("cancelAppointment", { ok: true, data: { cancelled: true } }),
      sync: op("sync", { ok: true, data: { recordsRead: 0, recordsWritten: 0, recordsFailed: 0 } }),
    },
  };
}

// Service deps: real registry resolution logic, injected connection + fake
// connector + injectable mappings and catalog. mappings:
// { "provider:prov-1": "12", … }; services: { "svc-1": {active, bookingEnabled, defaultDurationMin} };
// serviceMappings: { "conn-fict-1:svc-1": "OD-ext-77" }.
function fakeDeps({
  connection = fictConnection(),
  fake = fakeConnector({ availability: true, createAppointment: true, updateAppointment: true, cancelAppointment: true, findPatients: true, createPatient: true }),
  mappings = {}, services = {}, serviceMappings = {},
  patients = {},          // { "pat-fict-1": { workspaceId?, name, phone, email } }
  persistResult = { ok: true, status: "created", message: "Patient mapping established." },
  appointments = {},      // { "appt-fict-9": { date, time } }
  apptPersistResult = { ok: true, status: "created", message: "Appointment mapping established." },
  priorIntent = null,     // { id, status, detail } returned by latestIntent
  intentCreateResult = { ok: true, id: "intent-fict-1", message: "Intent recorded." },
} = {}) {
  const persistCalls = [];
  const apptPersistCalls = [];
  const intentCreates = [];
  const intentUpdates = [];
  const legacyWrites = [];
  return {
    fake,
    persistCalls, apptPersistCalls, intentCreates, intentUpdates, legacyWrites,
    deps: {
      getAppointment: async (ws, id) => (appointments[id] && ws === "ws-fict-A" ? { id, date: appointments[id].date, time: appointments[id].time } : null),
      persistApptMapping: async (ws, input) => { apptPersistCalls.push({ ws, input }); return apptPersistResult; },
      createIntent: async (ws, input) => { intentCreates.push({ ws, input }); return intentCreateResult; },
      updateIntent: async (ws, id, patch) => { intentUpdates.push({ ws, id, patch }); return { ok: true, message: "updated" }; },
      latestIntent: async () => priorIntent,
      writeLegacyRef: async (ws, apptId, extId) => { legacyWrites.push({ ws, apptId, extId }); return true; },
      getPatient: async (ws, id) => {
        const p = patients[id];
        return p && ws === (p.workspaceId ?? "ws-fict-A")
          ? { id, name: p.name ?? "Fictional Patient", phone: p.phone ?? null, email: p.email ?? null }
          : null;
      },
      persistPatientMapping: async (ws, input) => { persistCalls.push({ ws, input }); return persistResult; },
      getService: async (ws, sid) => {
        const s = services[sid];
        return s && ws === (s.workspaceId ?? "ws-fict-A")
          ? { id: sid, workspaceId: ws, name: s.name ?? "Fictional Service", displayName: null, code: s.code ?? null, description: null, defaultDurationMin: s.defaultDurationMin ?? null, active: s.active !== false, bookingEnabled: s.bookingEnabled !== false, createdAt: "", updatedAt: "" }
          : null;
      },
      getServiceExternal: async (ws, connId, sid) => serviceMappings[`${connId}:${sid}`] ?? null,
      getPrimary: async () => connection,
      resolvePrimary: async (ws, { getPrimary }) => {
        const conn = await getPrimary(ws);
        // Re-use the REAL resolver's checks by delegating to it with a stub
        // registry outcome: run the real function for failure cases, and
        // swap in the fake connector only when it succeeds.
        const real = await getPrimaryBookingConnector(ws, { getPrimary: async () => conn });
        if (!real.ok) return real;
        return { ok: true, resolved: { ...real.resolved, connector: fake.connector } };
      },
      getMapping: async (ws, connId, entityType, pydentId) => {
        const ext = mappings[`${entityType}:${pydentId}`];
        return ext ? { id: "map-fict", workspaceId: ws, connectionId: connId, entityType, pydentEntityId: pydentId, externalId: ext, externalType: null, externalUpdatedAt: null, lastSyncedAt: null, syncStatus: null, metadata: {}, createdAt: "", updatedAt: "" } : null;
      },
    },
  };
}

// ── 1–4. Fail-closed resolution ─────────────────────────────────────────────
test("missing workspace, no connection, disabled connection, unknown connector all fail closed", async () => {
  const { deps } = fakeDeps();
  assert.equal((await connectorAvailability("", { date: "2099-01-10" }, deps)).error.code, "invalid_request");

  const none = fakeDeps({ connection: null }).deps;
  assert.equal((await connectorAvailability(WS, { date: "2099-01-10" }, none)).error.code, "config_missing");

  const disabled = fakeDeps({ connection: fictConnection({ enabled: false }) }).deps;
  assert.equal((await connectorAvailability(WS, { date: "2099-01-10" }, disabled)).error.code, "unavailable");

  const unknown = fakeDeps({ connection: fictConnection({ connectorType: "dentrix" }) }).deps;
  assert.equal((await connectorAvailability(WS, { date: "2099-01-10" }, unknown)).error.code, "unsupported_connector");
});

// ── 5. Capability gating prevents invocation ────────────────────────────────
test("an unsupported capability returns a structured failure WITHOUT invoking the connector", async () => {
  const { deps, fake } = fakeDeps({ fake: fakeConnector({}) }); // zero capabilities
  for (const r of [
    await connectorAvailability(WS, { date: "2099-01-10" }, deps),
    await connectorReschedule(WS, { pydentAppointmentId: "appt-fict-1", date: "2099-01-11", time: "11:00" }, deps),
    await connectorCancel(WS, "appt-fict-1", deps),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "unsupported_capability");
  }
  assert.deepEqual(fake.calls, [], "no connector operation may have been invoked");
});

// ── 6–9. Provider identity: mappings only ───────────────────────────────────
test("a mapped provider resolves pydent id → external id; unmapped fails closed", async () => {
  const withMap = fakeDeps({ mappings: { "provider:prov-fict-1": "12" } });
  const ok = await resolveProviderExternalId(WS, "conn-fict-1", "prov-fict-1", withMap.deps);
  assert.deepEqual(ok, { ok: true, data: "12" });
  const noMap = await resolveProviderExternalId(WS, "conn-fict-1", "prov-fict-2", withMap.deps);
  assert.equal(noMap.ok, false);
  assert.equal(noMap.error.code, "provider_not_found");
});

test("provider NAMES are never used as identity and there is no first-provider fallback", async () => {
  const { deps, fake } = fakeDeps({ mappings: {} });
  // An unmapped provider id fails closed — the connector is never asked, so
  // neither a name nor any "first doctor" can be substituted downstream.
  const r = await connectorAvailability(WS, { date: "2099-01-10", pydentProviderId: "prov-fict-unmapped" }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "provider_not_found");
  assert.deepEqual(fake.calls, []);
  // The service module's own source never touches provider names:
  const src = await readFile(new URL("../src/lib/booking-connectors/service.ts", import.meta.url), "utf8");
  assert.equal(/providerName|provider\.name|sameProvider/.test(src), false, "service must not consult provider names");
});

// ── 10. Service identity never falls back to a first service ────────────────
// Since M1E-C-C create is UNLOCKED but strictly precondition-gated: every
// unresolved identity is a non-invoking failure, and a connector that
// genuinely lacks the capability fails before anything else.
test("create preconditions: unresolved identities fail closed without any connector call", async () => {
  // Valid row + patient mapping, but the service is unmapped → config_missing:
  const base = {
    appointments: { "appt-fict-9": { date: "2099-01-10", time: "10:00" } },
    patients: PAT,
    mappings: { "patient:pat-fict-1": "ext-pat-77" },
    services: { "svc-fict-1": { defaultDurationMin: 45 } },
  };
  const REQ = { pydentAppointmentId: "appt-fict-9", pydentPatientId: "pat-fict-1", pydentServiceId: "svc-fict-1", date: "2099-01-10", time: "10:00", durationMin: 30 };
  const svcUnmapped = fakeDeps(base);
  const r = await connectorCreateAppointment(WS, REQ, svcUnmapped.deps);
  assert.equal(r.error.code, "config_missing");
  assert.deepEqual(svcUnmapped.fake.calls, []);
  assert.deepEqual(svcUnmapped.intentCreates, [], "no intent before identities resolve");
  // Unmapped patient → config_missing, non-invoking:
  const patUnmapped = fakeDeps({ ...base, mappings: {}, serviceMappings: { "conn-fict-1:svc-fict-1": "OD-ext-77" } });
  assert.equal((await connectorCreateAppointment(WS, REQ, patUnmapped.deps)).error.code, "config_missing");
  assert.deepEqual(patUnmapped.fake.calls, []);
  // Supplied provider that doesn't map is NEVER silently discarded:
  const provUnmapped = fakeDeps({ ...base, mappings: { "patient:pat-fict-1": "ext-pat-77" }, serviceMappings: { "conn-fict-1:svc-fict-1": "OD-ext-77" } });
  const p = await connectorCreateAppointment(WS, { ...REQ, pydentProviderId: "prov-fict-unmapped" }, provUnmapped.deps);
  assert.equal(p.error.code, "provider_not_found");
  assert.deepEqual(provUnmapped.fake.calls, []);
  // Missing Pydent row / slot disagreement:
  const noRow = fakeDeps({ ...base, appointments: {} });
  assert.equal((await connectorCreateAppointment(WS, REQ, noRow.deps)).error.code, "appointment_not_found");
  const drift = fakeDeps(base);
  assert.equal((await connectorCreateAppointment(WS, { ...REQ, time: "11:00" }, drift.deps)).error.code, "invalid_request");
  // A connector that genuinely lacks the capability fails first:
  const noCap = fakeDeps({ fake: fakeConnector({}) });
  const capErr = await connectorCreateAppointment(WS, REQ, noCap.deps);
  assert.equal(capErr.error.code, "unsupported_capability");
  assert.deepEqual(noCap.fake.calls, []);
  // And availability never forwards a free-text service filter at all:
  const { deps: d2, fake: f2 } = fakeDeps({ mappings: { "provider:prov-fict-1": "12" } });
  await connectorAvailability(WS, { date: "2099-01-10", pydentProviderId: "prov-fict-1" }, d2);
  assert.equal(f2.calls[0].args[1].service, null, "no service identity may be forwarded");
});

// ── 11. Availability invokes only after safe resolution ─────────────────────
test("availability reaches the connector only with resolved identities and correct context", async () => {
  const { deps, fake } = fakeDeps({ mappings: { "provider:prov-fict-1": "12" } });
  const r = await connectorAvailability(WS, { date: "2099-01-10", pydentProviderId: "prov-fict-1", durationMin: 45 }, deps);
  assert.equal(r.ok, true);
  assert.equal(fake.calls.length, 1);
  const [ctx, req] = fake.calls[0].args;
  assert.deepEqual(ctx, { workspaceId: WS, connectionId: "conn-fict-1" });
  assert.deepEqual(req.provider, { pydentId: "prov-fict-1", externalId: "12" });
  assert.equal(req.durationMin, 45);
  // Provider-less availability is legitimate (whole-clinic slots):
  const { deps: d2, fake: f2 } = fakeDeps();
  await connectorAvailability(WS, { date: "2099-01-10" }, d2);
  assert.equal(f2.calls[0].args[1].provider, null);
  // A malformed date never reaches the connector:
  const { deps: d3, fake: f3 } = fakeDeps();
  assert.equal((await connectorAvailability(WS, { date: "soon" }, d3)).error.code, "invalid_request");
  assert.deepEqual(f3.calls, []);
});

// ── 13/14. Update/cancel require a mapped external appointment identity ─────
test("reschedule and cancel resolve the appointment mapping or fail closed", async () => {
  const mapped = fakeDeps({ mappings: { "appointment:appt-fict-1": "987" } });
  const ok = await connectorReschedule(WS, { pydentAppointmentId: "appt-fict-1", date: "2099-01-11", time: "11:00" }, mapped.deps);
  assert.equal(ok.ok, true);
  assert.deepEqual(mapped.fake.calls[0].args[1].appointment, { pydentId: "appt-fict-1", externalId: "987" });

  const cancelMapped = fakeDeps({ mappings: { "appointment:appt-fict-1": "987" } });
  const c = await connectorCancel(WS, "appt-fict-1", cancelMapped.deps);
  assert.deepEqual(c, { ok: true, data: { cancelled: true } });
  assert.deepEqual(cancelMapped.fake.calls[0].args[1], { pydentId: "appt-fict-1", externalId: "987" });

  for (const makeCall of [
    (d) => connectorReschedule(WS, { pydentAppointmentId: "appt-fict-unmapped", date: "2099-01-11", time: "11:00" }, d),
    (d) => connectorCancel(WS, "appt-fict-unmapped", d),
  ]) {
    const unmapped = fakeDeps({ mappings: {} });
    const r = await makeCall(unmapped.deps);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "appointment_not_found");
    assert.deepEqual(unmapped.fake.calls, [], "the connector must not be invoked without an external identity");
  }
});

// ── 15/16. No direct DB access; the only write is the injected, narrowly
// scoped patient-mapping establishment (booking-connections-server's
// insert-not-overwrite function) — nothing generic, nothing direct. ────────
test("the service has no direct DB access: no supabase, no generic upserts, no raw column writes", async () => {
  const src = await readFile(new URL("../src/lib/booking-connectors/service.ts", import.meta.url), "utf8");
  for (const forbidden of ["supabase", "upsertExternalMapping", ".insert(", ".update(", ".delete(", "external_id"]) {
    assert.equal(src.includes(forbidden), false, `service.ts must not contain "${forbidden}"`);
  }
});

// ── 17. Exactly ONE sanctioned production caller imports the service ────────
test("booking-server.ts is the ONLY production code outside booking-connectors touching the layer (M1E-C-D)", async () => {
  const offenders = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (p.includes("booking-connectors") || e.name === "node_modules") continue;
        await walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        const srcTxt = await readFile(p, "utf8");
        if (srcTxt.includes("booking-connectors")) offenders.push(p);
      }
    }
  }
  await walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(
    offenders.map((p) => p.split("/src/").pop()),
    ["lib/booking-server.ts"],
    "M1E-C-D sanctions bookAppointmentStructured's module as the single adoption point — no other channel may wire the layer independently"
  );
});

// ════ M1E-B: appointment ↔ service identity ═════════════════════════════════

const sql68 = await readFile(new URL("../supabase/migrations/0068_appointment_service_identity.sql", import.meta.url), "utf8");

test("0068: nullable service_id, workspace-consistent composite FK, ON DELETE RESTRICT", () => {
  assert.match(sql68, /add column if not exists service_id uuid;/);          // nullable — no NOT NULL anywhere
  assert.doesNotMatch(sql68, /service_id uuid not null/);
  assert.match(sql68, /add constraint services_id_ws_uq unique \(id, workspace_id\)/); // supporting pair (0067 untouched)
  // Composite FK with explicit RESTRICT: a service referenced by any
  // appointment is intentionally undeletable (retire with active=false);
  // a service nothing references deletes normally — no trigger/rule in the
  // migration blocks that, only this FK governs deletion.
  assert.match(sql68, /foreign key \(service_id, workspace_id\)\s+references public\.services \(id, workspace_id\)\s+on delete restrict/);
  assert.doesNotMatch(sql68, /set null/i, "no SET NULL form (and no PG15 column-list dependency) may remain");
  assert.doesNotMatch(sql68, /create trigger|create rule/i);
  assert.match(sql68, /active = false/, "retirement-by-flag must be the documented alternative to deletion");
  // MATCH SIMPLE guard RETAINED: appointments.workspace_id is nullable in
  // the real schema (0014 added it without NOT NULL), so the check is
  // required, not redundant:
  assert.match(sql68, /check \(service_id is null or workspace_id is not null\)/);
  assert.match(sql68, /create index if not exists appointments_ws_service_idx\s+on public\.appointments \(workspace_id, service_id\)/);
  // No backfill, no derivation, no touch of the legacy procedure column:
  assert.doesNotMatch(sql68, /update public\.appointments|UPDATE appointments/i);
  assert.equal(sql68.includes("procedure ="), false);
});

test("appointment writers never set the service_id COLUMN", async () => {
  // Manual writers stay fully service_id-free. booking-server.ts (M1E-C-D)
  // carries service_id only as the caller-supplied connector identity
  // ARGUMENT — the appointments INSERT/UPDATE payloads still never set the
  // 0068 column (unapplied elsewhere), so pre-migration databases keep
  // accepting every booking.
  const db = await readFile(new URL("../src/lib/db.ts", import.meta.url), "utf8");
  assert.equal(db.includes("service_id"), false, "db.ts must not set service_id (manual adoption is a later milestone)");
  const bs = await readFile(new URL("../src/lib/booking-server.ts", import.meta.url), "utf8");
  const insertRow = bs.slice(bs.indexOf("const baseRow"), bs.indexOf(".insert(baseRow)"));
  assert.equal(insertRow.includes("service_id"), false, "the appointments insert payload must not carry the 0068 column");
  assert.doesNotMatch(bs, /\.update\(\{[^}]*service_id/s, "no appointments update sets service_id either");
  // Every service_id occurrence in CODE (comments aside) is the identity
  // argument or its optional-field declaration, never a column write:
  const code = bs.replace(/\/\/[^\n]*/g, "");
  for (const m of code.matchAll(/[\w.]*service_id\??(:|\b)/g)) {
    assert.match(m[0], /^(args\.service_id|service_id\?:)/, `unexpected service_id use: ${m[0]}`);
  }
});

test("service resolution: fail-closed ladder (inputs, unknown, inactive, non-bookable, unmapped)", async () => {
  const base = { services: { "svc-fict-1": { defaultDurationMin: 45 } }, serviceMappings: { "conn-fict-1:svc-fict-1": "OD-ext-77" } };
  const { deps } = fakeDeps(base);
  for (const [ws, conn, sid] of [["", "conn-fict-1", "svc-fict-1"], ["ws-fict-A", "", "svc-fict-1"], ["ws-fict-A", "conn-fict-1", " "]]) {
    assert.equal((await resolveServiceForConnection(ws, conn, sid, deps)).error.code, "invalid_request");
  }
  assert.equal((await resolveServiceForConnection("ws-fict-A", "conn-fict-1", "svc-fict-unknown", deps)).error.code, "config_missing");
  const inactive = fakeDeps({ ...base, services: { "svc-fict-1": { active: false } } });
  assert.equal((await resolveServiceForConnection("ws-fict-A", "conn-fict-1", "svc-fict-1", inactive.deps)).error.code, "unavailable");
  const notBookable = fakeDeps({ ...base, services: { "svc-fict-1": { bookingEnabled: false } } });
  assert.equal((await resolveServiceForConnection("ws-fict-A", "conn-fict-1", "svc-fict-1", notBookable.deps)).error.code, "unavailable");
  const unmapped = fakeDeps({ ...base, serviceMappings: {} });
  const um = await resolveServiceForConnection("ws-fict-A", "conn-fict-1", "svc-fict-1", unmapped.deps);
  assert.equal(um.error.code, "config_missing");
  assert.match(um.error.message, /no external identity mapped/);
});

test("service resolution: mapped service resolves for the right connection; name/code never used; no leak across workspaces", async () => {
  const { deps } = fakeDeps({
    services: { "svc-fict-1": { name: "Cleaning", code: "CLN-internal", defaultDurationMin: 45 } },
    serviceMappings: { "conn-fict-1:svc-fict-1": "OD-ext-77", "conn-OTHER:svc-fict-1": "WRONG-99" },
  });
  const ok = await resolveServiceForConnection("ws-fict-A", "conn-fict-1", "svc-fict-1", deps);
  assert.deepEqual(ok, { ok: true, data: { pydentServiceId: "svc-fict-1", externalServiceId: "OD-ext-77", defaultDurationMin: 45 } });
  // The external identity is the MAPPING for THIS connection — never the
  // name, never the internal code, never another connection's mapping:
  assert.notEqual(ok.data.externalServiceId, "Cleaning");
  assert.notEqual(ok.data.externalServiceId, "CLN-internal");
  assert.notEqual(ok.data.externalServiceId, "WRONG-99");
  const src = await readFile(new URL("../src/lib/booking-connectors/service.ts", import.meta.url), "utf8");
  assert.equal(/svc\.name|svc\.code/.test(src), false, "resolution must not consult service name/code");
  // A foreign workspace's service id gets the SAME answer as an unknown one:
  const foreign = await resolveServiceForConnection("ws-fict-B", "conn-fict-1", "svc-fict-1", deps);
  const unknown = await resolveServiceForConnection("ws-fict-A", "conn-fict-1", "svc-fict-nope", deps);
  assert.equal(foreign.error.code, "config_missing");
  assert.deepEqual(foreign.error, unknown.error, "wrong-workspace must be indistinguishable from unknown");
});

// (M1E-C-C) The former lock test becomes the HAPPY PATH: with every identity
// resolved, the saga runs in the mandated order.
const CREATE_FIXTURES = {
  appointments: { "appt-fict-9": { date: "2099-01-10", time: "10:00" } },
  mappings: { "patient:pat-fict-1": "ext-pat-77", "provider:prov-fict-1": "12" },
  services: { "svc-fict-1": { defaultDurationMin: 45 } },
  serviceMappings: { "conn-fict-1:svc-fict-1": "OD-ext-77" },
};
const CREATE_REQ = { pydentAppointmentId: "appt-fict-9", pydentPatientId: "pat-fict-1", pydentServiceId: "svc-fict-1", pydentProviderId: "prov-fict-1", date: "2099-01-10", time: "10:00", durationMin: 30 };

function happyCreateDeps(extra = {}) {
  return fakeDeps({
    ...CREATE_FIXTURES,
    patients: PAT,
    fake: fakeConnector(
      { availability: true, createAppointment: true },
      {
        getAvailability: { ok: true, data: [{ date: "2099-01-10", time: "10:00", durationMin: null, provider: null, operatory: null }] },
        createAppointment: { ok: true, data: { pydentAppointmentId: null, externalId: "ext-appt-500", date: "2099-01-10", time: "10:00", durationMin: null, provider: {}, operatory: null, service: "", status: "Scheduled", patient: null } },
      }
    ),
    ...extra,
  });
}

test("unlocked create happy path follows the mandated saga order", async () => {
  const d = happyCreateDeps();
  const r = await connectorCreateAppointment(WS, CREATE_REQ, d.deps);
  assert.equal(r.ok, true);
  assert.equal(r.data.externalId, "ext-appt-500");
  // Order: availability re-check → intent → EXTERNAL WRITE; intent precedes the write:
  assert.deepEqual(d.fake.calls.map((c) => c.name), ["getAvailability", "createAppointment"]);
  assert.equal(d.intentCreates.length, 1);
  assert.equal(d.intentCreates[0].input.syncType, "appointment_push");
  const det = d.intentCreates[0].input.detail;
  assert.deepEqual(det, { pydentAppointmentId: "appt-fict-9", pydentPatientId: "pat-fict-1", patientExternalId: "ext-pat-77", serviceExternalId: "OD-ext-77", date: "2099-01-10", time: "10:00" });
  assert.equal(Object.keys(det).some((k) => /name|phone|email/i.test(k)), false, "intent carries correlation only, no PII");
  // External write carried the MAPPED identities, not names/free text:
  const sent = d.fake.calls[1].args[1];
  assert.equal(sent.patient.externalId, "ext-pat-77");
  assert.equal(sent.serviceExternalId, "OD-ext-77");
  assert.equal(sent.provider.externalId, "12");
  // Then mapping → legacy compat → intent succeeded:
  assert.equal(d.apptPersistCalls.length, 1);
  assert.equal(d.apptPersistCalls[0].input.externalId, "ext-appt-500");
  assert.deepEqual(d.legacyWrites, [{ ws: WS, apptId: "appt-fict-9", extId: "ext-appt-500" }]);
  const last = d.intentUpdates.at(-1);
  assert.equal(last.patch.status, "succeeded");
  assert.equal(last.patch.detail.externalId, "ext-appt-500");
});

test("stale slot blocks the write; duplicate (already mapped) is idempotent with zero external calls", async () => {
  const stale = happyCreateDeps({
    fake: fakeConnector({ availability: true, createAppointment: true }, { getAvailability: { ok: true, data: [{ date: "2099-01-10", time: "09:00", durationMin: null, provider: null, operatory: null }] } }),
  });
  const s = await connectorCreateAppointment(WS, CREATE_REQ, stale.deps);
  assert.equal(s.error.code, "slot_unavailable");
  assert.equal(stale.fake.calls.some((c) => c.name === "createAppointment"), false);
  assert.deepEqual(stale.intentCreates, [], "no intent for a write that was never attempted");

  const dup = happyCreateDeps({ mappings: { ...CREATE_FIXTURES.mappings, "appointment:appt-fict-9": "ext-appt-500" } });
  const r = await connectorCreateAppointment(WS, CREATE_REQ, dup.deps);
  assert.equal(r.ok, true);
  assert.equal(r.data.externalId, "ext-appt-500");
  assert.deepEqual(dup.fake.calls, [], "completed duplicate returns the existing mapping — zero external calls");
});

test("pending/unknown intents block; a ledger-recorded external id recovers WITHOUT a second PMS create", async () => {
  const unknown = happyCreateDeps({ priorIntent: { id: "intent-old", status: "unknown", detail: { pydentAppointmentId: "appt-fict-9" } } });
  const u = await connectorCreateAppointment(WS, CREATE_REQ, unknown.deps);
  assert.equal(u.error.code, "external_error");
  assert.match(u.error.message, /reconciliation/i);
  assert.deepEqual(unknown.fake.calls, [], "no blind retry while an outcome is unknown");

  const recoverable = happyCreateDeps({ priorIntent: { id: "intent-old", status: "running", detail: { pydentAppointmentId: "appt-fict-9", externalId: "ext-appt-500" } } });
  const rec = await connectorCreateAppointment(WS, CREATE_REQ, recoverable.deps);
  assert.equal(rec.ok, true);
  assert.equal(rec.data.externalId, "ext-appt-500");
  assert.deepEqual(recoverable.fake.calls, [], "recovery completes local persistence with ZERO second PMS creates");
  assert.equal(recoverable.apptPersistCalls.length, 1);
  assert.equal(recoverable.intentUpdates.at(-1).patch.status, "succeeded");
});

test("definite rejection marks failed (retry allowed); indeterminate transport marks unknown; mapping failure retains the id", async () => {
  const rejected = happyCreateDeps({
    fake: fakeConnector({ availability: true, createAppointment: true }, {
      getAvailability: { ok: true, data: [{ date: "2099-01-10", time: "10:00", durationMin: null, provider: null, operatory: null }] },
      createAppointment: { ok: false, error: { code: "slot_unavailable", message: "The requested slot is no longer available in Open Dental." } },
    }),
  });
  const rej = await connectorCreateAppointment(WS, CREATE_REQ, rejected.deps);
  assert.equal(rej.error.code, "slot_unavailable");
  assert.equal(rejected.intentUpdates.at(-1).patch.status, "failed");

  const timedOut = happyCreateDeps({
    fake: fakeConnector({ availability: true, createAppointment: true }, {
      getAvailability: { ok: true, data: [{ date: "2099-01-10", time: "10:00", durationMin: null, provider: null, operatory: null }] },
      createAppointment: { ok: false, error: { code: "unavailable", message: "Open Dental could not be reached: timed out — nothing answered in time." } },
    }),
  });
  const t = await connectorCreateAppointment(WS, CREATE_REQ, timedOut.deps);
  assert.equal(t.error.code, "external_error");
  assert.match(t.error.message, /UNKNOWN/);
  assert.equal(timedOut.intentUpdates.at(-1).patch.status, "unknown");

  // Provably-not-sent network failure stays a DEFINITE failure:
  const refused = happyCreateDeps({
    fake: fakeConnector({ availability: true, createAppointment: true }, {
      getAvailability: { ok: true, data: [{ date: "2099-01-10", time: "10:00", durationMin: null, provider: null, operatory: null }] },
      createAppointment: { ok: false, error: { code: "unavailable", message: "Open Dental could not be reached: connection refused at fict.example." } },
    }),
  });
  await connectorCreateAppointment(WS, CREATE_REQ, refused.deps);
  assert.equal(refused.intentUpdates.at(-1).patch.status, "failed");

  // PMS success + mapping persistence failure: id retained in the ledger,
  // caller told recovery needs no second create; intent NOT marked failed.
  const persistFail = happyCreateDeps({ apptPersistResult: { ok: false, message: "insert failed" } });
  const pf = await connectorCreateAppointment(WS, CREATE_REQ, persistFail.deps);
  assert.equal(pf.error.code, "external_error");
  assert.match(pf.error.message, /no second external create|without a second/i);
  const idUpdate = persistFail.intentUpdates.find((u) => u.patch.detail?.externalId === "ext-appt-500");
  assert.ok(idUpdate, "the returned external id must be retained in the intent ledger before mapping");
  // And a mapping conflict is surfaced, never overwritten:
  const conflict = happyCreateDeps({ apptPersistResult: { ok: false, conflictingExternalId: "ext-OLD", message: "different" } });
  assert.equal((await connectorCreateAppointment(WS, CREATE_REQ, conflict.deps)).error.code, "external_conflict");
});

test("reconciliation: ledger-adopt, probe zero clears, exactly one adopts, several fail closed", async () => {
  const mkIntent = (detail) => ({ id: "intent-old", status: "unknown", detail: { pydentAppointmentId: "appt-fict-9", patientExternalId: "ext-pat-77", date: "2099-01-10", time: "10:00", ...detail } });
  const probe = (rows) => fakeConnector({ findAppointments: true }, { findAppointments: { ok: true, data: rows } });

  const ledger = happyCreateDeps({ priorIntent: mkIntent({ externalId: "ext-appt-500" }) });
  const l = await reconcileAppointmentCreate(WS, "appt-fict-9", ledger.deps);
  assert.deepEqual(l.data, { outcome: "adopted", externalId: "ext-appt-500" });
  assert.deepEqual(ledger.fake.calls, [], "ledger adoption needs no probe");

  const zero = happyCreateDeps({ priorIntent: mkIntent({}), fake: probe([]) });
  const z = await reconcileAppointmentCreate(WS, "appt-fict-9", zero.deps);
  assert.deepEqual(z.data, { outcome: "cleared" });
  assert.equal(zero.intentUpdates.at(-1).patch.status, "failed"); // controlled retry now possible

  const one = happyCreateDeps({ priorIntent: mkIntent({}), fake: probe([{ externalId: "ext-appt-777", date: "2099-01-10", time: "10:00" }, { externalId: "ext-other", date: "2099-01-10", time: "15:00" }]) });
  const o = await reconcileAppointmentCreate(WS, "appt-fict-9", one.deps);
  assert.deepEqual(o.data, { outcome: "adopted", externalId: "ext-appt-777" }); // time filter leaves exactly one
  assert.equal(one.apptPersistCalls[0].input.metadata.method, "reconciliation_probe");

  const many = happyCreateDeps({ priorIntent: mkIntent({}), fake: probe([{ externalId: "e1", date: "2099-01-10", time: "10:00" }, { externalId: "e2", date: "2099-01-10", time: "10:00" }]) });
  const m = await reconcileAppointmentCreate(WS, "appt-fict-9", many.deps);
  assert.equal(m.error.code, "ambiguous_match");
  assert.deepEqual(many.apptPersistCalls, [], "never adopt one of several");

  const already = happyCreateDeps({ mappings: { ...CREATE_FIXTURES.mappings, "appointment:appt-fict-9": "ext-appt-500" } });
  assert.deepEqual((await reconcileAppointmentCreate(WS, "appt-fict-9", already.deps)).data, { outcome: "already_established", externalId: "ext-appt-500" });

  const nothing = happyCreateDeps({ priorIntent: { id: "i", status: "failed", detail: {} } });
  assert.equal((await reconcileAppointmentCreate(WS, "appt-fict-9", nothing.deps)).error.code, "invalid_request");

  const noProbeCap = happyCreateDeps({ priorIntent: mkIntent({}), fake: fakeConnector({}) });
  assert.equal((await reconcileAppointmentCreate(WS, "appt-fict-9", noProbeCap.deps)).error.code, "unsupported_capability");
});

// ════ M1E-C-B: patient identity — resolution + establishment ════════════════

const PAT = { "pat-fict-1": { name: "Fictional Patient", phone: "+971 50 000 0001", email: "fict@example.test" } };

test("patient resolution: mapping always wins, no PMS search, demographics never consulted", async () => {
  const mapped = fakeDeps({ patients: PAT, mappings: { "patient:pat-fict-1": "ext-pat-77" } });
  const r = await resolvePatientForConnection("ws-fict-A", "conn-fict-1", "pat-fict-1", mapped.deps);
  assert.deepEqual(r, { ok: true, data: { pydentPatientId: "pat-fict-1", externalPatientId: "ext-pat-77" } });
  assert.deepEqual(mapped.fake.calls, [], "resolution must never search the external system");
  assert.deepEqual(mapped.persistCalls, [], "resolution must never write");
});

test("patient resolution fails closed: unmapped, unknown, cross-workspace, missing inputs", async () => {
  const d = fakeDeps({ patients: PAT });
  const unmapped = await resolvePatientForConnection("ws-fict-A", "conn-fict-1", "pat-fict-1", d.deps);
  assert.equal(unmapped.error.code, "config_missing");
  const unknown = await resolvePatientForConnection("ws-fict-A", "conn-fict-1", "pat-fict-nope", d.deps);
  const foreign = await resolvePatientForConnection("ws-fict-B", "conn-fict-1", "pat-fict-1", d.deps);
  assert.equal(unknown.error.code, "patient_not_found");
  assert.deepEqual(foreign.error, unknown.error, "cross-workspace must be indistinguishable from unknown");
  assert.equal((await resolvePatientForConnection("", "conn-fict-1", "pat-fict-1", d.deps)).error.code, "invalid_request");
});

test("establishment: exactly one coherent candidate persists a provenance-carrying patient mapping", async () => {
  const d = fakeDeps({
    patients: PAT,
    fake: fakeConnector({ findPatients: true }, { findPatients: { ok: true, data: [{ externalId: "ext-pat-77", name: "Fictional Patient", phone: "0500000001", email: "fict@example.test" }] } }),
  });
  const r = await establishPatientMapping("ws-fict-A", "pat-fict-1", d.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { pydentPatientId: "pat-fict-1", externalPatientId: "ext-pat-77", established: "matched" });
  assert.equal(d.persistCalls.length, 1);
  const w = d.persistCalls[0];
  assert.equal(w.ws, "ws-fict-A");
  assert.equal(w.input.connectionId, "conn-fict-1");
  assert.equal(w.input.pydentPatientId, "pat-fict-1");
  assert.equal(w.input.externalId, "ext-pat-77");
  assert.equal(w.input.metadata.method, "phone_search");
  assert.equal(w.input.metadata.phoneEvidence, "…0001"); // provenance, not full PII
});

test("establishment distinguishes zero / many / conflicting candidates and never picks first-of-many", async () => {
  const zero = fakeDeps({ patients: PAT, fake: fakeConnector({ findPatients: true }, { findPatients: { ok: true, data: [] } }) });
  const z = await establishPatientMapping("ws-fict-A", "pat-fict-1", zero.deps);
  assert.equal(z.error.code, "patient_not_found");
  assert.match(z.error.message, /separate, explicit step/);

  const many = fakeDeps({ patients: PAT, fake: fakeConnector({ findPatients: true }, { findPatients: { ok: true, data: [{ externalId: "ext-1" }, { externalId: "ext-2" }] } }) });
  const m = await establishPatientMapping("ws-fict-A", "pat-fict-1", many.deps);
  assert.equal(m.error.code, "ambiguous_match"); // distinguishable from conflict AND not-found
  assert.deepEqual(many.persistCalls, [], "no candidate may be selected from several");

  const conflict = fakeDeps({ patients: PAT, fake: fakeConnector({ findPatients: true }, { findPatients: { ok: true, data: [{ externalId: "ext-9", email: "other-person@example.test" }] } }) });
  const c = await establishPatientMapping("ws-fict-A", "pat-fict-1", conflict.deps);
  assert.equal(c.error.code, "external_conflict");
  assert.deepEqual(conflict.persistCalls, [], "conflicting identifiers persist nothing");
  assert.ok(new Set([z.error.code, m.error.code, c.error.code]).size === 3, "the three failure shapes stay distinguishable");
});

test("establishment: idempotent on existing mapping; needs phone evidence; name is never identity", async () => {
  const existing = fakeDeps({ patients: PAT, mappings: { "patient:pat-fict-1": "ext-pat-77" } });
  const e = await establishPatientMapping("ws-fict-A", "pat-fict-1", existing.deps);
  assert.deepEqual(e.data, { pydentPatientId: "pat-fict-1", externalPatientId: "ext-pat-77", established: "existing" });
  assert.deepEqual(existing.fake.calls, [], "an existing mapping wins without any search");

  const nameOnly = fakeDeps({ patients: { "pat-fict-2": { name: "Named But Phoneless" } } });
  const n = await establishPatientMapping("ws-fict-A", "pat-fict-2", nameOnly.deps);
  assert.equal(n.error.code, "invalid_request");
  assert.match(n.error.message, /name alone never establishes identity/);
  assert.deepEqual(nameOnly.fake.calls, []);
  // And the search request shape itself has no name field (contract-level):
  const src = await readFile(new URL("../src/lib/booking-connectors/types.ts", import.meta.url), "utf8");
  const block = src.slice(src.indexOf("interface ConnectorPatientSearchRequest"));
  assert.equal(block.slice(0, block.indexOf("}")).includes("name"), false);
});

test("mapping persistence failure means NOT established; conflicting existing mapping is never overwritten", async () => {
  const failPersist = fakeDeps({
    patients: PAT,
    fake: fakeConnector({ findPatients: true }, { findPatients: { ok: true, data: [{ externalId: "ext-pat-77" }] } }),
    persistResult: { ok: false, message: "insert failed" },
  });
  const f = await establishPatientMapping("ws-fict-A", "pat-fict-1", failPersist.deps);
  assert.equal(f.error.code, "external_error");
  assert.match(f.error.message, /NOT established/);

  const conflictPersist = fakeDeps({
    patients: PAT,
    fake: fakeConnector({ findPatients: true }, { findPatients: { ok: true, data: [{ externalId: "ext-NEW" }] } }),
    persistResult: { ok: false, conflictingExternalId: "ext-OLD", message: "different identity" },
  });
  const c = await establishPatientMapping("ws-fict-A", "pat-fict-1", conflictPersist.deps);
  assert.equal(c.error.code, "external_conflict");
});

test("establishment by creation: create then persist; persistence failure blocks establishment", async () => {
  const d = fakeDeps({ patients: PAT });
  const r = await establishPatientByCreation("ws-fict-A", "pat-fict-1", d.deps);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { pydentPatientId: "pat-fict-1", externalPatientId: "ext-pat-new", established: "created" });
  assert.equal(d.fake.calls[0].name, "createPatient");
  assert.equal(d.persistCalls[0].input.metadata.method, "created");

  const failing = fakeDeps({ patients: PAT, persistResult: { ok: false, message: "insert failed" } });
  const f = await establishPatientByCreation("ws-fict-A", "pat-fict-1", failing.deps);
  assert.equal(f.error.code, "external_error");
  assert.match(f.error.message, /no booking is possible/);

  const noCap = fakeDeps({ patients: PAT, fake: fakeConnector({}) });
  assert.equal((await establishPatientByCreation("ws-fict-A", "pat-fict-1", noCap.deps)).error.code, "unsupported_capability");
  assert.deepEqual(noCap.fake.calls, []);
});

test("no unintended mapping writes, and create stays locked even with an established patient", async () => {
  const d = fakeDeps({
    patients: PAT,
    mappings: { "provider:prov-fict-1": "12", "patient:pat-fict-1": "ext-pat-77", "appointment:appt-fict-1": "987" },
    services: { "svc-fict-1": {} }, serviceMappings: { "conn-fict-1:svc-fict-1": "OD-ext-77" },
  });
  // Non-establishment operations never touch the mapping writer:
  await connectorAvailability("ws-fict-A", { date: "2099-01-10" }, d.deps);
  await resolvePatientForConnection("ws-fict-A", "conn-fict-1", "pat-fict-1", d.deps);
  await connectorReschedule("ws-fict-A", { pydentAppointmentId: "appt-fict-1", date: "2099-01-11", time: "11:00" }, d.deps);
  await connectorCancel("ws-fict-A", "appt-fict-1", d.deps);
  const create = await connectorCreateAppointment("ws-fict-A", {}, d.deps);
  assert.deepEqual(d.persistCalls, [], "only the two establishment flows may write a patient mapping");
  assert.deepEqual(d.apptPersistCalls, [], "no appointment mapping outside the create saga");
  // An under-specified create fails validation without reaching the connector:
  assert.equal(create.ok, false);
  assert.equal(create.error.code, "invalid_request");
  assert.equal(d.fake.calls.some((c) => c.name === "createAppointment"), false, "connector.createAppointment unreachable without full preconditions");
});

// ── 18/19. Structured errors, no secret leakage ─────────────────────────────
test("connector errors propagate as structured failures and never carry config secrets", async () => {
  const failing = fakeDeps({
    fake: fakeConnector({ availability: true }, { getAvailability: { ok: false, error: { code: "external_error", message: "Open Dental returned HTTP 500." } } }),
  });
  const r = await connectorAvailability(WS, { date: "2099-01-10" }, failing.deps);
  assert.equal(r.ok, false);
  assert.deepEqual(Object.keys(r.error).sort(), ["code", "message"]);
  assert.equal(r.error.code, "external_error");
  // The connection's config carries a fictional secret — no failure path may echo it.
  const cases = [
    await connectorAvailability(WS, { date: "2099-01-10" }, fakeDeps({ connection: fictConnection({ enabled: false }) }).deps),
    await connectorCreateAppointment(WS, {}, fakeDeps().deps),
    await connectorCancel(WS, "x", fakeDeps({ mappings: {} }).deps),
    r,
  ];
  for (const c of cases) assert.equal(JSON.stringify(c.error).includes("sk-fict-SECRET-999"), false);
});
