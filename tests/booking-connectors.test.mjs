// M1C BookingConnector contract + registry: PMS-neutral vocabulary,
// fail-closed context handling, workspace/connection mismatch rejection,
// honest placeholder behavior, and a leak-free error model. Deterministic,
// fictional data, no database, no network (the primary resolver takes
// injected deps).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { connectorError, connectorFail, NO_CAPABILITIES } = await import("@/lib/booking-connectors/types");
const { resolveBookingConnector, getPrimaryBookingConnector, registeredConnectorTypes } = await import("@/lib/booking-connectors/registry");

// A fictional, fully-shaped connection row. The config value looks like a
// credential ON PURPOSE — it must never surface in any error message.
function fictConnection(overrides = {}) {
  return {
    id: "conn-fict-1",
    workspaceId: "ws-fict-A",
    connectorType: "opendental",
    displayName: "Fictional Clinic PMS",
    enabled: true,
    isPrimary: true,
    config: { hint: "sk-fict-SECRET-999" },
    lastSyncAt: null,
    syncStatus: null,
    lastError: null,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
const CTX = { workspaceId: "ws-fict-A", connectionId: "conn-fict-1" };

// ── 1/12. The contract stays PMS-neutral ────────────────────────────────────
test("connector contract contains no PMS-specific terminology", async () => {
  const src = await readFile(new URL("../src/lib/booking-connectors/types.ts", import.meta.url), "utf8");
  for (const forbidden of ["AptNum", "PatNum", "ProvNum", "OpNum", "ScheduleNum", "ODFHIR", "Dentrix", "opendental_config"]) {
    assert.equal(src.includes(forbidden), false, `types.ts must not mention "${forbidden}"`);
  }
});

// ── 2. Known connector types resolve ────────────────────────────────────────
test("all three known connector types are registered and resolvable", () => {
  assert.deepEqual(registeredConnectorTypes().sort(), ["d4w", "opendental", "pydent_native"]);
  for (const type of ["opendental", "d4w", "pydent_native"]) {
    const r = resolveBookingConnector(fictConnection({ connectorType: type }), CTX);
    assert.equal(r.ok, true, `${type} must resolve`);
    assert.equal(r.resolved.connector.type, type);
  }
});

// ── 3. Unknown/future types are handled explicitly ──────────────────────────
test("an unknown connector type is explicitly rejected, never mapped elsewhere", () => {
  const r = resolveBookingConnector(fictConnection({ connectorType: "dentrix" }), CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "unsupported_connector");
  const bad = resolveBookingConnector(fictConnection({ connectorType: "not a type!" }), CTX);
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, "invalid_request");
});

// ── 4. Missing context fails closed ─────────────────────────────────────────
test("missing workspace or connection context fails closed", () => {
  for (const ctx of [null, {}, { workspaceId: "ws-fict-A" }, { connectionId: "conn-fict-1" }, { workspaceId: " ", connectionId: "conn-fict-1" }]) {
    const r = resolveBookingConnector(fictConnection(), ctx);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "invalid_request");
  }
});

// ── 5/6/9. Mismatches are rejected — no fallback of any kind ────────────────
test("workspace mismatch and connection-id mismatch are rejected", () => {
  const wsMismatch = resolveBookingConnector(fictConnection({ workspaceId: "ws-fict-B" }), CTX);
  assert.equal(wsMismatch.ok, false);
  assert.equal(wsMismatch.error.code, "invalid_request");
  const idMismatch = resolveBookingConnector(fictConnection({ id: "conn-fict-OTHER" }), CTX);
  assert.equal(idMismatch.ok, false);
  assert.equal(idMismatch.error.code, "invalid_request");
  const noConn = resolveBookingConnector(null, CTX);
  assert.equal(noConn.ok, false);
  assert.equal(noConn.error.code, "config_missing");
});

// ── 7. Disabled connection is rejected ──────────────────────────────────────
test("a disabled connection never resolves to a connector", () => {
  const r = resolveBookingConnector(fictConnection({ enabled: false }), CTX);
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "unavailable");
});

// ── 8. Placeholders cannot masquerade as operational ────────────────────────
// (Since M1D-A, 'opendental' resolves to the real adapter — the placeholder
// guarantees are pinned on the still-unwired 'd4w' type.)
test("placeholder connectors declare zero capabilities and every operation says not_implemented", async () => {
  const r = resolveBookingConnector(fictConnection({ connectorType: "d4w" }), CTX);
  assert.equal(r.ok, true);
  const c = r.resolved.connector;
  assert.deepEqual(c.getCapabilities(), NO_CAPABILITIES);
  const ops = [
    c.testConnection(CTX),
    c.getProviders(CTX),
    c.getSchedules(CTX, { dateFrom: "2099-01-01", dateTo: "2099-01-07" }),
    c.getOperatories(CTX),
    c.getAppointments(CTX, { dateFrom: "2099-01-01", dateTo: "2099-01-07" }),
    c.getAvailability(CTX, { date: "2099-01-01" }),
    c.findPatients(CTX, { phone: "0500000001" }),
    c.createPatient(CTX, { name: "Fictional Patient", phone: "0500000001" }),
    c.createAppointment(CTX, { patient: { name: "Fictional Patient" }, service: "Cleaning", date: "2099-01-01", time: "10:00", durationMin: 30 }),
    c.updateAppointment(CTX, { appointment: { externalId: "fict-1" }, time: "11:00" }),
    c.cancelAppointment(CTX, { externalId: "fict-1" }),
    c.sync(CTX, { syncType: "initial_import" }),
  ];
  for (const out of await Promise.all(ops)) {
    assert.equal(out.ok, false);
    assert.equal(out.error.code, "not_implemented");
    assert.match(out.error.message, /No operation was performed/);
  }
});

// ── 10. Primary connector resolver ──────────────────────────────────────────
test("primary resolver: fails closed without workspace, clearly with no connection, honestly when unimplemented", async () => {
  const noWs = await getPrimaryBookingConnector("");
  assert.equal(noWs.ok, false);
  assert.equal(noWs.error.code, "invalid_request");

  const none = await getPrimaryBookingConnector("ws-fict-A", { getPrimary: async () => null });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, "config_missing");

  const disabled = await getPrimaryBookingConnector("ws-fict-A", { getPrimary: async () => fictConnection({ enabled: false }) });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.error.code, "unavailable");

  // A connection from ANOTHER workspace returned by a buggy dep is still
  // rejected — the registry re-checks, so no cross-workspace resolution.
  const foreign = await getPrimaryBookingConnector("ws-fict-A", { getPrimary: async () => fictConnection({ workspaceId: "ws-fict-B" }) });
  assert.equal(foreign.ok, false);

  // (d4w here: since M1D-A 'opendental' resolves to the real adapter, whose
  // behavior is covered with injected deps in tests/opendental-connector.)
  const okCase = await getPrimaryBookingConnector("ws-fict-A", { getPrimary: async () => fictConnection({ connectorType: "d4w" }) });
  assert.equal(okCase.ok, true);
  assert.equal(okCase.resolved.connector.type, "d4w");
  assert.deepEqual(okCase.resolved.context, CTX);
  // …but the resolved placeholder still refuses to operate:
  const health = await okCase.resolved.connector.testConnection(CTX);
  assert.equal(health.ok, false);
  assert.equal(health.error.code, "not_implemented");
});

// ── 11. Error model never leaks secrets ─────────────────────────────────────
test("errors carry only a code and a bounded message — never connection config", async () => {
  const e = connectorError("external_error", "x".repeat(1000));
  assert.deepEqual(Object.keys(e).sort(), ["code", "message"]);
  assert.equal(e.message.length, 300);
  const f = connectorFail("auth_failed", "keys rejected");
  assert.equal(f.ok, false);
  assert.deepEqual(Object.keys(f.error).sort(), ["code", "message"]);
  // No rejection path may echo the connection's config (fictional secret).
  const cases = [
    resolveBookingConnector(fictConnection({ enabled: false }), CTX),
    resolveBookingConnector(fictConnection({ workspaceId: "ws-fict-B" }), CTX),
    resolveBookingConnector(fictConnection({ connectorType: "dentrix" }), CTX),
    await getPrimaryBookingConnector("ws-fict-A", { getPrimary: async () => fictConnection({ enabled: false }) }),
  ];
  for (const r of cases) {
    assert.equal(r.ok, false);
    assert.equal(JSON.stringify(r.error).includes("sk-fict-SECRET-999"), false, "error must not contain config values");
  }
});
