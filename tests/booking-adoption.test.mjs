// M1E-C-D first caller adoption: the explicit adoption gate, structural
// double-write exclusion between the connector arm and the legacy Open
// Dental forward, service/provider/patient identity propagation rules, the
// external_sync tri-state, duplicate-retry semantics, channel convergence
// and dormancy before migrations. Deterministic fakes and source pins only —
// no database, no network, fictional data throughout.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const {
  connectorAdoptionEnabled, chooseServiceIdentity, runConnectorSync,
  bookAppointmentStructured,
} = await import("@/lib/booking-server");

const src = await readFile(new URL("../src/lib/booking-server.ts", import.meta.url), "utf8");
const bookBody = src.slice(
  src.indexOf("export async function bookAppointmentStructured"),
  src.indexOf("export async function bookAppointment(")
);

// A fictional adopted connection; config is the 0066 non-secret jsonb.
const CONN = {
  id: "conn-fict-1", workspaceId: "ws-fict-A", connectorType: "opendental", displayName: "Fict OD",
  enabled: true, isPrimary: true, config: { bookingAdoption: "connector", defaultServiceId: "svc-fict-default" },
  lastSyncAt: null,
};

function fakeSyncDeps(overrides = {}) {
  const rec = { creates: [], intentLookups: [], gateLookups: 0 };
  const deps = {
    getPrimaryConnection: async () => { rec.gateLookups += 1; return overrides.conn ?? null; },
    syncCreate: async (ws, req) => { rec.creates.push({ ws, req }); return overrides.createResult ?? { ok: true, data: { pydentId: req.pydentAppointmentId, externalId: "ext-fict-900", date: req.date, time: req.time, durationMin: null, status: "scheduled" } }; },
    latestIntent: async (ws, connId, apptId) => { rec.intentLookups.push({ ws, connId, apptId }); return overrides.intent ?? null; },
  };
  return { deps, rec };
}

// ── The adoption gate ───────────────────────────────────────────────────────
test("gate: connection existence alone never adopts — only enabled+primary+explicit opt-in", () => {
  assert.equal(connectorAdoptionEnabled(null), false, "no connection → legacy");
  assert.equal(connectorAdoptionEnabled({ ...CONN, enabled: false }), false, "disabled connection → legacy");
  assert.equal(connectorAdoptionEnabled({ ...CONN, isPrimary: false }), false, "non-primary connection → legacy");
  assert.equal(connectorAdoptionEnabled({ ...CONN, config: {} }), false, "enabled primary WITHOUT bookingAdoption opt-in → legacy");
  assert.equal(connectorAdoptionEnabled({ ...CONN, config: { bookingAdoption: "legacy" } }), false, "any other opt-in value → legacy");
  assert.equal(connectorAdoptionEnabled({ ...CONN, config: null }), false, "null config → legacy");
  assert.equal(connectorAdoptionEnabled(CONN), true, "enabled + primary + explicit opt-in → connector");
});

test("dormancy: a missing 0066 schema resolves gate-off, never a booking failure", async () => {
  // getPrimaryBookingConnection fails CLOSED to null on any error (missing
  // table before migrations, no database at all) — pinned at the source so
  // adoption stays dormant everywhere until 0066 exists AND a connection
  // opts in. No clinic adopts merely because this code shipped.
  const connSrc = await readFile(new URL("../src/lib/booking-connections-server.ts", import.meta.url), "utf8");
  const fn = connSrc.slice(connSrc.indexOf("export async function getPrimaryBookingConnection"), connSrc.indexOf("// ── External mappings"));
  assert.match(fn, /catch\s*\{\s*return null;/);
  assert.equal(connectorAdoptionEnabled(null), false);
});

// ── Service identity selection ──────────────────────────────────────────────
test("service identity: explicit service_id ALWAYS wins and is never replaced by the default", () => {
  assert.equal(chooseServiceIdentity("svc-fict-explicit", CONN), "svc-fict-explicit");
  // An invalid/unknown explicit id is still the one sent — it fails closed
  // downstream rather than silently becoming the configured default:
  assert.equal(chooseServiceIdentity("svc-fict-NOT-A-REAL-SERVICE", CONN), "svc-fict-NOT-A-REAL-SERVICE");
  // Absent (or blank) explicit id → the connection's pilot default:
  assert.equal(chooseServiceIdentity(undefined, CONN), "svc-fict-default");
  assert.equal(chooseServiceIdentity("   ", CONN), "svc-fict-default");
  // No default configured → empty, which the connector service rejects:
  assert.equal(chooseServiceIdentity(undefined, { ...CONN, config: { bookingAdoption: "connector" } }), "");
  assert.equal(chooseServiceIdentity(undefined, null), "");
});

test("free-text service/treatment/doctor can never establish connector identity", () => {
  // chooseServiceIdentity sees only the explicit id argument and the
  // connection config — no name-shaped input exists in its source:
  const fn = src.slice(src.indexOf("export function chooseServiceIdentity"), src.indexOf("const DEFINITE_NO_WRITE_CODES"));
  for (const banned of ["treatment", "doctor", "args.service,", "args.name"]) {
    assert.equal(fn.includes(banned), false, `chooseServiceIdentity must not consult "${banned}"`);
  }
  // And the saga request built by runConnectorSync carries ONLY UUID-based
  // identity fields — no names, phones, emails or free-text labels:
  const run = src.slice(src.indexOf("export async function runConnectorSync"), src.indexOf("// Book an appointment onto the Calendar"));
  for (const banned of ["treatment", "doctor", "name", "phone", "email"]) {
    assert.equal(run.includes(banned), false, `runConnectorSync must not reference "${banned}"`);
  }
  // Both call sites feed service identity from args.service_id and provider
  // identity from args.provider_id, never from the free-text fields:
  assert.equal((bookBody.match(/serviceIdArg: args\.service_id/g) ?? []).length, 2);
  assert.equal((bookBody.match(/providerIdArg: args\.provider_id/g) ?? []).length, 2);
  assert.equal(/serviceIdArg: args\.(service|treatment)\b/.test(bookBody), false);
  assert.equal(/providerIdArg: args\.doctor/.test(bookBody), false);
});

// ── runConnectorSync: identity propagation + tri-state semantics ────────────
test("sync request carries the exact Pydent UUIDs: patient as resolved, explicit service, optional provider", async () => {
  const { deps, rec } = fakeSyncDeps();
  const r = await runConnectorSync("ws-fict-A", CONN, {
    pydentAppointmentId: "appt-fict-1", pydentPatientId: "pat-fict-7",
    serviceIdArg: "svc-fict-explicit", providerIdArg: "prov-fict-3",
    date: "2031-04-07", time: "10:30", durationMin: 30,
  }, deps);
  assert.deepEqual(r, { external_sync: "synced" });
  assert.equal(rec.creates.length, 1);
  assert.deepEqual(rec.creates[0].req, {
    pydentAppointmentId: "appt-fict-1",
    pydentPatientId: "pat-fict-7",
    pydentServiceId: "svc-fict-explicit",   // explicit wins over svc-fict-default
    pydentProviderId: "prov-fict-3",
    date: "2031-04-07", time: "10:30", durationMin: 30,
  });
  assert.equal(rec.intentLookups.length, 0, "a successful sync never consults the ledger");
});

test("no provider_id → provider omitted entirely (strict slot-derived provider downstream)", async () => {
  const { deps, rec } = fakeSyncDeps();
  await runConnectorSync("ws-fict-A", CONN, { pydentAppointmentId: "a", pydentPatientId: "p", date: "2031-04-07", time: "10:30", durationMin: 30 }, deps);
  assert.equal(rec.creates[0].req.pydentProviderId, undefined);
  assert.equal(rec.creates[0].req.pydentServiceId, "svc-fict-default", "absent service_id uses the configured pilot default");
});

test("invalid supplied service_id fails closed — the default is NOT substituted", async () => {
  const { deps, rec } = fakeSyncDeps({ createResult: { ok: false, error: { code: "config_missing", message: "No service mapping." } } });
  const r = await runConnectorSync("ws-fict-A", CONN, {
    pydentAppointmentId: "a", pydentPatientId: "p", serviceIdArg: "svc-fict-INVALID", date: "2031-04-07", time: "10:30", durationMin: 30,
  }, deps);
  assert.deepEqual(r, { external_sync: "failed", code: "config_missing" });
  assert.equal(rec.creates.length, 1, "exactly one attempt — no retry with the default");
  assert.equal(rec.creates[0].req.pydentServiceId, "svc-fict-INVALID");
});

test("invalid configured default also fails closed (same downstream validation)", async () => {
  const { deps, rec } = fakeSyncDeps({ createResult: { ok: false, error: { code: "invalid_request", message: "A service id is required." } } });
  const conn = { ...CONN, config: { bookingAdoption: "connector", defaultServiceId: "  " } };
  const r = await runConnectorSync("ws-fict-A", conn, { pydentAppointmentId: "a", pydentPatientId: "p", date: "2031-04-07", time: "10:30", durationMin: 30 }, deps);
  assert.equal(r.external_sync, "failed");
  assert.equal(rec.creates[0].req.pydentServiceId, "", "a blank default passes through empty and is rejected, never invented");
});

test("tri-state: definite no-write codes are 'failed' without a ledger read", async () => {
  for (const code of ["invalid_request", "config_missing", "unsupported_capability", "not_implemented", "slot_unavailable", "patient_not_found", "provider_not_found", "appointment_not_found", "ambiguous_match", "unsupported_connector"]) {
    const { deps, rec } = fakeSyncDeps({ createResult: { ok: false, error: { code, message: "definite" } } });
    const r = await runConnectorSync("ws-fict-A", CONN, { pydentAppointmentId: "a", pydentPatientId: "p", serviceIdArg: "s", date: "2031-04-07", time: "10:30", durationMin: 30 }, deps);
    assert.deepEqual(r, { external_sync: "failed", code });
    assert.equal(rec.intentLookups.length, 0, `${code} proves no write was dispatched`);
  }
});

test("tri-state: possibly-dispatched failures are adjudicated by the intent ledger", async () => {
  const cases = [
    { intent: { status: "running" }, expect: "unknown" },  // in-flight / persist-failed-after-success
    { intent: { status: "unknown" }, expect: "unknown" },  // transport interrupted after dispatch
    { intent: { status: "failed" }, expect: "failed" },    // ledger says it definitely did not happen
    { intent: null, expect: "failed" },                     // no intent was ever persisted
  ];
  for (const c of cases) {
    const { deps, rec } = fakeSyncDeps({ createResult: { ok: false, error: { code: "external_error", message: "ambiguous transport" } }, intent: c.intent });
    const r = await runConnectorSync("ws-fict-A", CONN, { pydentAppointmentId: "appt-fict-1", pydentPatientId: "p", serviceIdArg: "s", date: "2031-04-07", time: "10:30", durationMin: 30 }, deps);
    assert.deepEqual(r, { external_sync: c.expect, code: "external_error" });
    assert.deepEqual(rec.intentLookups, [{ ws: "ws-fict-A", connId: "conn-fict-1", apptId: "appt-fict-1" }]);
  }
});

// ── Structural double-write exclusion inside bookAppointmentStructured ──────
test("ONE gate decision, computed once, selects exactly one external path", () => {
  assert.equal((bookBody.match(/const adoptConnector = connectorAdoptionEnabled\(primaryConn\);/g) ?? []).length, 1, "the adoption decision is computed exactly once");
  assert.equal((bookBody.match(/syncDeps\.getPrimaryConnection/g) ?? []).length, 1, "one gate lookup per request");
  // The legacy Open Dental forward exists exactly once, INSIDE the
  // !adoptConnector arm — structurally unreachable under adoption:
  assert.equal((bookBody.match(/\/create-appointment/g) ?? []).length, 1);
  const legacyArm = bookBody.slice(bookBody.indexOf("if (!adoptConnector) {"), bookBody.indexOf("catch { /* keep the Calendar booking even if Open Dental is unreachable */ }"));
  assert.match(legacyArm, /odForward\(ws, "\/create-appointment"/, "the ONLY legacy create-forward lives in the gate-off arm");
  assert.equal(legacyArm.includes("runConnectorSync"), false, "the legacy arm never calls the connector");
  // The connector arm is guarded by the SAME boolean, so failure there can
  // never fall through into the legacy forward:
  assert.equal((bookBody.match(/if \(adoptConnector && primaryConn && ws\)/g) ?? []).length, 2, "both connector call sites (duplicate retry + main) sit behind the gate");
  const connectorArm = bookBody.slice(bookBody.indexOf("let externalSync"), bookBody.indexOf("void (async () =>"));
  assert.equal(connectorArm.includes("odForward"), false, "no legacy fallback inside the connector arm");
});

test("local-first ordering: the connector arm runs only after the local INSERT succeeded", () => {
  const insertAt = bookBody.indexOf('.insert(baseRow)');
  const connectorAt = bookBody.indexOf("let externalSync");
  const dbErrorAt = bookBody.indexOf('"db_error"');
  assert.ok(insertAt > 0 && connectorAt > insertAt, "connector sync follows the local appointment insert");
  assert.ok(dbErrorAt > 0 && dbErrorAt < connectorAt, "a failed local insert returns before any connector call");
});

test("duplicate retry drives the EXISTING appointment UUID and can never insert or blind-create", () => {
  const dupBlock = bookBody.slice(bookBody.indexOf("if (dup?.length)"), bookBody.indexOf("// Fill in the lead's"));
  assert.match(dupBlock, /pydentAppointmentId: String\(dup\[0\]\.id\)/, "the retry targets the existing local appointment UUID");
  assert.equal(dupBlock.includes(".insert("), false, "the duplicate path can never create a second local appointment");
  assert.equal((dupBlock.match(/return \{ success: false, error: "duplicate_booking"/g) ?? []).length, 2, "both arms return without booking");
  assert.match(dupBlock, /external_sync: sync\.external_sync/, "the retry surfaces the C-C idempotency/recovery outcome");
  // Blind-second-create protection is C-C's: mapping → idempotent, running/
  // unknown intent → blocked, ledger externalId → recovery without a PMS
  // write — all already proven in booking-connector-service tests. Here we
  // pin that the retry goes through that same saga and nothing else:
  assert.equal(dupBlock.includes("odForward"), false);
});

test("Google Calendar and workflow triggers run in BOTH gate branches; spoken lines are unchanged", () => {
  const legacyArmEnd = bookBody.indexOf("catch { /* keep the Calendar booking even if Open Dental is unreachable */ }");
  for (const kept of ["pushToGoogleCalendar", "triggerWorkflows"]) {
    const at = bookBody.indexOf(kept);
    assert.ok(at > legacyArmEnd, `${kept} sits OUTSIDE the legacy-only arm, so it runs whichever branch was taken`);
  }
  // Patient-facing language is untouched — the agent still confirms the
  // clinic-calendar booking and never narrates PMS/network outcomes:
  assert.match(bookBody, /spoken: `Appointment booked: \$\{treatment\}/);
  const dupSpokenLit = bookBody.match(/const dupSpoken = "([^"]+)"/)?.[1] ?? "";
  assert.equal(dupSpokenLit, "This patient already has an appointment at that exact time — no duplicate was booked.");
  // No patient-facing string narrates sync/PMS state (every spoken literal
  // in this function is checked — staff-only ctx.log lines are exempt):
  for (const lit of [...bookBody.matchAll(/spoken: `([^`]*)`/g), ...bookBody.matchAll(/spoken: "([^"]*)"/g)]) {
    assert.equal(/external|PMS|sync|connector/i.test(lit[1]), false, `spoken text must not narrate sync state: ${lit[1]}`);
  }
});

// ── Live behavior: the one safely-executable path ───────────────────────────
test("invalid datetime returns before the gate — zero lookups, zero connector calls", async () => {
  const { deps, rec } = fakeSyncDeps({ conn: CONN });
  const r = await bookAppointmentStructured(
    { ws: "ws-fict-A", patientId: null, name: "Fictional Caller", phone: "", source: "voice", bookedBy: "Fict Agent" },
    { datetime: "" },
    deps
  );
  assert.equal(r.success, false);
  assert.equal(r.error, "invalid_datetime");
  assert.equal(rec.gateLookups, 0);
  assert.equal(rec.creates.length, 0);
});

// ── Channel convergence + isolation ─────────────────────────────────────────
test("all five agent channels still converge on booking-server and none wires the connector layer", async () => {
  const channels = [
    "src/app/api/agents/tool-exec/route.ts",   // LiveKit voice worker
    "src/app/api/sms/webhook/route.ts",        // SMS
    "src/app/api/whatsapp/webhook/route.ts",   // WhatsApp/chat
    "src/app/api/vapi/events/route.ts",        // Vapi legacy voice
    "src/lib/builder-tools-deps.ts",           // Builder HTTP tools
  ];
  for (const f of channels) {
    const txt = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    assert.match(txt, /from "@\/lib\/booking-server"/, `${f} books through booking-server`);
    assert.match(txt, /bookAppointment/, `${f} uses the converged booking function`);
    assert.equal(txt.includes("booking-connectors"), false, `${f} must not wire the connector layer independently`);
  }
});

test("connectorCreateAppointment has exactly one production caller: booking-server.ts", async () => {
  const offenders = [];
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (p.includes("booking-connectors") || e.name === "node_modules") continue; await walk(p); }
      else if (/\.(ts|tsx)$/.test(e.name) && (await readFile(p, "utf8")).includes("connectorCreateAppointment")) offenders.push(p.split("/src/").pop());
    }
  }
  await walk(new URL("../src", import.meta.url).pathname);
  assert.deepEqual(offenders, ["lib/booking-server.ts"]);
});

test("manual booking paths remain OUTSIDE adoption", async () => {
  for (const f of ["src/lib/db.ts", "src/app/api/opendental/book/route.ts"]) {
    const txt = await readFile(new URL(`../${f}`, import.meta.url), "utf8");
    assert.equal(txt.includes("booking-connectors"), false, `${f} is not adopted in M1E-C-D`);
    assert.equal(txt.includes("external_sync"), false, `${f} carries no adoption surface`);
  }
});

// ── Builder tool contract ───────────────────────────────────────────────────
test("Builder book_appointment passes the UUID identities through and surfaces external_sync", async () => {
  const bt = await readFile(new URL("../src/lib/builder-tools.ts", import.meta.url), "utf8");
  assert.match(bt, /service_id: str\(args\.service_id\)/);
  assert.match(bt, /provider_id: str\(args\.provider_id\)/);
  assert.match(bt, /external_sync: r\.external_sync \?\? "not_applicable"/);
  // The free-text fields keep flowing as calendar labels only — they feed
  // `service`/`treatment`/`doctor`, never the *_id identity fields:
  assert.equal(/service_id: str\(args\.(service|treatment)\)/.test(bt), false);
  assert.equal(/provider_id: str\(args\.doctor\)/.test(bt), false);
});
