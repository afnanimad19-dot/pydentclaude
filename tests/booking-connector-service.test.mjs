// M1D-B booking connector service: fail-closed resolution, capability
// gating, mapping-only identity (no name/first-anything fallback), honest
// create unavailability, and isolation from production callers. All deps
// injected — fictional data, no Supabase, no Open Dental, no network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const { connectorAvailability, connectorCreateAppointment, connectorReschedule, connectorCancel, resolveProviderExternalId, resolveServiceForConnection, CREATE_UNAVAILABLE_REASON } =
  await import("@/lib/booking-connectors/service");
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
function fakeDeps({ connection = fictConnection(), fake = fakeConnector({ availability: true, createAppointment: true, updateAppointment: true, cancelAppointment: true }), mappings = {}, services = {}, serviceMappings = {} } = {}) {
  return {
    fake,
    deps: {
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
// Capability vs readiness: the connector DOES support creation (Open Dental
// advertises createAppointment: true), so the failure is config_missing —
// missing Pydent-side identity configuration — never unsupported_capability.
test("create is a config_missing readiness failure: no guessing, connector never invoked", async () => {
  const { deps, fake } = fakeDeps(); // fake declares createAppointment: true
  const r = await connectorCreateAppointment(WS, { anything: true }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "config_missing");
  assert.notEqual(r.error.code, "unsupported_capability");
  assert.match(r.error.message, /patient-identity policy/); // M1E-B: service identity resolves; patient policy is the remaining blocker
  assert.equal(r.error.message, CREATE_UNAVAILABLE_REASON.slice(0, r.error.message.length));
  assert.deepEqual(fake.calls, [], "createAppointment must never reach the connector in M1D-B");
  // The REAL Open Dental adapter still advertises the capability:
  const { OPENDENTAL_CAPABILITIES } = await import("@/lib/booking-connectors/opendental");
  assert.equal(OPENDENTAL_CAPABILITIES.createAppointment, true);
  // A connector that genuinely lacks the capability still gets the accurate
  // capability error, BEFORE the readiness check:
  const noCap = fakeDeps({ fake: fakeConnector({}) });
  const capErr = await connectorCreateAppointment(WS, {}, noCap.deps);
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

// ── 15/16. No mapping writes, no external_id writes, no direct DB access ────
test("the service is read-only orchestration: no supabase, no upserts, no external_id writes", async () => {
  const src = await readFile(new URL("../src/lib/booking-connectors/service.ts", import.meta.url), "utf8");
  for (const forbidden of ["supabase", "upsertExternalMapping", ".insert(", ".update(", ".delete(", "external_id"]) {
    assert.equal(src.includes(forbidden), false, `service.ts must not contain "${forbidden}"`);
  }
});

// ── 17. No production caller imports the service ────────────────────────────
test("no production code outside booking-connectors imports the service (or the layer at all)", async () => {
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
  assert.deepEqual(offenders, [], "the connector service must have no production callers in M1D-B");
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

test("legacy appointment writers never supply service_id", async () => {
  for (const f of ["../src/lib/db.ts", "../src/lib/booking-server.ts"]) {
    const src = await readFile(new URL(f, import.meta.url), "utf8");
    assert.equal(src.includes("service_id"), false, `${f} must not set service_id (caller adoption is a later milestone)`);
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

test("create stays locked even when provider AND service identities fully resolve", async () => {
  const { deps, fake } = fakeDeps({
    mappings: { "provider:prov-fict-1": "12" },
    services: { "svc-fict-1": { defaultDurationMin: 45 } },
    serviceMappings: { "conn-fict-1:svc-fict-1": "OD-ext-77" },
  });
  const ready = await resolveServiceForConnection("ws-fict-A", "conn-fict-1", "svc-fict-1", deps);
  assert.equal(ready.ok, true); // prerequisites resolve…
  const r = await connectorCreateAppointment("ws-fict-A", { serviceId: "svc-fict-1" }, deps);
  assert.equal(r.ok, false);    // …and create still refuses
  assert.equal(r.error.code, "config_missing");
  assert.deepEqual(fake.calls, [], "connector.createAppointment must never be invoked by M1E-B");
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
