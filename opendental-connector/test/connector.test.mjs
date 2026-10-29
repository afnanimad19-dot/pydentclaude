// Security-hardening test suite for the Pydent Open Dental Connector.
// Everything runs against the in-process app with stubbed data layers or a
// local throwaway HTTP server — NO real Open Dental is ever contacted.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { createApp, safeEqual } from "../src/app.js";
import { createClient, OdError, odDateTime } from "../src/opendental.js";

const KEY = "unit-test-key-0123456789";
const BASE_CONFIG = { mock: true, readOnly: true, clinicApiKey: KEY, baseUrl: "http://127.0.0.1:1", developerKey: "", customerKey: "", timeoutMs: 1000, port: 0 };

const liveEnv = {
  CLINIC_API_KEY: KEY,
  OPEN_DENTAL_BASE_URL: "http://localhost:30222/api/v1",
  OPEN_DENTAL_DEVELOPER_KEY: "dev-key",
  OPEN_DENTAL_CUSTOMER_KEY: "cust-key",
};

// A data layer that must never be reached — proves gates fire BEFORE Open Dental.
const untouchable = new Proxy({}, { get: (_t, prop) => () => { throw new Error(`data layer called (${String(prop)}) although the request should have been rejected first`); } });

function listen(app) {
  return new Promise((resolve) => {
    const srv = app.listen(0, "127.0.0.1", () => resolve(srv));
  });
}
const urlOf = (srv, p) => `http://127.0.0.1:${srv.address().port}${p}`;
const H = { "Content-Type": "application/json", "x-api-key": KEY };

async function withApp(opts, fn) {
  const srv = await listen(createApp(opts));
  try {
    return await fn((p) => urlOf(srv, p));
  } finally {
    srv.close();
  }
}

// Local stand-in for the Open Dental API (never the real thing).
async function withUpstream(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    return await fn(base);
  } finally {
    srv.close();
    srv.closeAllConnections?.();
  }
}

// ── 1. Explicit mock mode ─────────────────────────────────────────────────────

test("mock mode activates ONLY on OPEN_DENTAL_MOCK=1 — never on missing keys", () => {
  assert.equal(loadConfig({ ...liveEnv, OPEN_DENTAL_MOCK: "1" }).config.mock, true);
  assert.equal(loadConfig({ ...liveEnv }).config.mock, false);
  assert.equal(loadConfig({ ...liveEnv, OPEN_DENTAL_MOCK: "true" }).config.mock, false, '"true" is not the explicit opt-in');
  // The old dangerous behaviour: no developer key used to mean silent mock.
  const r = loadConfig({ CLINIC_API_KEY: KEY });
  assert.equal(r.ok, false, "missing live credentials are a STARTUP FAILURE, not silent mock");
});

// ── 2. Missing live credentials fail startup, naming variables not values ────

test("startup fails on missing credentials and never prints secret values", () => {
  const r = loadConfig({ CLINIC_API_KEY: KEY, OPEN_DENTAL_DEVELOPER_KEY: "", OPEN_DENTAL_CUSTOMER_KEY: "secret-cust" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes("OPEN_DENTAL_DEVELOPER_KEY")));
  assert.ok(!JSON.stringify(r.errors).includes("secret-cust"), "error text must not contain key values");

  const noKey = loadConfig({ OPEN_DENTAL_MOCK: "1" });
  assert.equal(noKey.ok, false, "CLINIC_API_KEY is required even in mock mode");
  assert.ok(noKey.errors.some((e) => e.includes("CLINIC_API_KEY")));
  assert.equal(loadConfig({ OPEN_DENTAL_MOCK: "1", CLINIC_API_KEY: "short" }).ok, false, "a trivially short shared secret is refused");
});

test("read-only mode is the default; only an explicit 0 disables it", () => {
  assert.equal(loadConfig({ ...liveEnv }).config.readOnly, true);
  assert.equal(loadConfig({ ...liveEnv, OPEN_DENTAL_READ_ONLY: "1" }).config.readOnly, true);
  assert.equal(loadConfig({ ...liveEnv, OPEN_DENTAL_READ_ONLY: "0" }).config.readOnly, false);
});

// ── 3. Read-only booking rejection (before any Open Dental call) ─────────────

test("read-only mode rejects create/reschedule/cancel with 403 before the data layer", async () => {
  await withApp({ od: untouchable, config: { ...BASE_CONFIG, readOnly: true } }, async (u) => {
    for (const [p, body] of [
      ["/create-appointment", { name: "Test Patient", phone: "+971500000000", doctorId: "12", serviceId: "cleaning", datetime: "2027-01-05T10:00" }],
      ["/reschedule-appointment", { appointmentId: 5001, datetime: "2027-01-05T11:00" }],
      ["/cancel-appointment", { appointmentId: 5001 }],
    ]) {
      const res = await fetch(u(p), { method: "POST", headers: H, body: JSON.stringify(body) });
      assert.equal(res.status, 403, `${p} is blocked`);
      const j = await res.json();
      assert.equal(j.error, "read_only_mode");
      assert.ok(!JSON.stringify(j).includes("Test Patient"), "no patient data echoed");
    }
    // Reads still work in read-only mode.
    const docs = await fetch(u("/doctors"), { headers: H });
    assert.equal(docs.status, 200);
  });
});

// ── 4./5. Strict doctor & service validation — no silent first-item pick ─────

test("unknown doctor / unknown service / not-offered service are rejected, nothing defaults", async () => {
  await withApp({ od: untouchable, config: { ...BASE_CONFIG, readOnly: false } }, async (u) => {
    const post = (p, body) => fetch(u(p), { method: "POST", headers: H, body: JSON.stringify(body) });

    let res = await post("/available-slots", { doctorId: "999", serviceId: "cleaning", date: "2027-01-05" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unknown_doctor");

    res = await post("/available-slots", { serviceId: "cleaning", date: "2027-01-05" }); // missing id
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unknown_doctor");

    res = await post("/available-slots", { doctorId: "12", serviceId: "nope", date: "2027-01-05" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unknown_service");

    // Dr 12 does not offer whitening in the mappings.
    res = await post("/available-slots", { doctorId: "12", serviceId: "whitening", date: "2027-01-05" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "service_not_offered");

    res = await post("/create-appointment", { name: "T P", phone: "+971500000000", doctorId: "999", serviceId: "cleaning", datetime: "2027-01-05T10:00" });
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error, "unknown_doctor");
  });
});

test("request validation: date, datetime, duration, appointment id, required booking fields", async () => {
  const od = { getSlots: async () => ["09:00"], findOrCreatePatient: async () => 7001, createAppointment: async () => ({ AptNum: 9001 }) };
  await withApp({ od, config: { ...BASE_CONFIG, readOnly: false } }, async (u) => {
    const post = (p, body) => fetch(u(p), { method: "POST", headers: H, body: JSON.stringify(body) });
    const err = async (res, code, status = 400) => { assert.equal(res.status, status); assert.equal((await res.json()).error, code); };

    await err(await post("/available-slots", { doctorId: "12", serviceId: "cleaning", date: "05-01-2027" }), "invalid_date");
    await err(await post("/available-slots", { doctorId: "12", serviceId: "cleaning", date: "2027-01-05", durationMin: 3 }), "invalid_duration");
    await err(await post("/available-slots", { doctorId: "12", serviceId: "cleaning", date: "2027-01-05", durationMin: "abc" }), "invalid_duration");
    await err(await post("/create-appointment", { name: "T P", phone: "+971500000000", doctorId: "12", serviceId: "cleaning", datetime: "tomorrow 10am" }), "invalid_datetime");
    await err(await post("/create-appointment", { doctorId: "12", serviceId: "cleaning", datetime: "2027-01-05T10:00" }), "missing_name");
    await err(await post("/create-appointment", { name: "T P", doctorId: "12", serviceId: "cleaning", datetime: "2027-01-05T10:00" }), "missing_phone");
    await err(await post("/reschedule-appointment", { appointmentId: "abc", datetime: "2027-01-05T10:00" }), "invalid_appointment_id");
    await err(await post("/cancel-appointment", {}), "invalid_appointment_id");

    const ok = await post("/create-appointment", { name: "T P", phone: "+971500000000", doctorId: "12", serviceId: "cleaning", datetime: "2027-01-05T10:00" });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, appointmentId: 9001, patNum: 7001 });
  });
});

// ── 6./7. Shared-secret authentication ───────────────────────────────────────

test("missing or wrong x-api-key is 401; health needs no key but exposes no data", async () => {
  await withApp({ od: untouchable, config: BASE_CONFIG }, async (u) => {
    assert.equal((await fetch(u("/doctors"))).status, 401);
    assert.equal((await fetch(u("/doctors"), { headers: { "x-api-key": "wrong-key-0123456789" } })).status, 401);
    const unauthorized = await (await fetch(u("/doctors"), { headers: { "x-api-key": "x" } })).json();
    assert.deepEqual(unauthorized, { error: "unauthorized" }, "401 body carries nothing else");

    const health = await fetch(u("/health"));
    assert.equal(health.status, 200);
    const j = await health.json();
    assert.deepEqual(Object.keys(j).sort(), ["mode", "ok", "readOnly", "service"], "health exposes mode flags only");
    assert.ok(!JSON.stringify(j).includes(KEY), "health never contains the shared secret");
  });
});

test("timing-safe comparison helper handles differing lengths without throwing", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", "x"), false);
});

// ── 8.–10. Open Dental client: timeout / auth failure / no mock fallback ─────

const clientConfig = (base, extra = {}) => ({ baseUrl: base, developerKey: "dev-key", customerKey: "cust-key", timeoutMs: 300, ...extra });

test("OD client: a hanging Open Dental API is a timeout error, not an empty calendar", async () => {
  await withUpstream((_req, _res) => { /* never answers */ }, async (base) => {
    const client = createClient(clientConfig(base, { timeoutMs: 200 }));
    await assert.rejects(client.getSlots({ providerNum: 12, operatoryNum: 1, date: "2027-01-05", durationMin: 30 }), (e) => e instanceof OdError && e.code === "od_timeout");
  });
});

test("OD client: 401/403 from Open Dental is od_auth_failed and sends the documented ODFHIR header", async () => {
  let seenAuth = "";
  await withUpstream((req, res) => { seenAuth = req.headers.authorization; res.writeHead(401).end("{}"); }, async (base) => {
    const client = createClient(clientConfig(base));
    await assert.rejects(client.getSlots({ providerNum: 12, operatoryNum: 1, date: "2027-01-05", durationMin: 30 }), (e) => e.code === "od_auth_failed");
    assert.equal(seenAuth, "ODFHIR dev-key/cust-key");
  });
});

test("OD client: HTTP errors and malformed bodies become typed errors that carry NO upstream text", async () => {
  await withUpstream((req, res) => {
    if (req.url.includes("Slots")) res.writeHead(500).end(JSON.stringify({ error: "stack trace with PATIENT Jane Roe +97150xxxxxxx" }));
    else res.writeHead(200).end("<html>not json</html>");
  }, async (base) => {
    const client = createClient(clientConfig(base));
    await assert.rejects(
      client.getSlots({ providerNum: 12, operatoryNum: 1, date: "2027-01-05", durationMin: 30 }),
      (e) => e.code === "od_http_error" && !String(e.message).includes("Jane Roe")
    );
    await assert.rejects(client.findOrCreatePatient({ name: "A B", phone: "" }), (e) => e.code === "od_bad_response");
  });
});

test("app: upstream failures return safe fixed messages — no mock data, no leakage", async () => {
  const cases = [
    [new OdError("od_timeout"), 504, "upstream_timeout"],
    [new OdError("od_auth_failed", 401), 502, "od_auth_failed"],
    [new OdError("od_http_error", 500), 502, "od_error"],
    [new Error("raw internal: key=dev-key patient=Jane Roe"), 502, "upstream_failed"],
  ];
  for (const [thrown, status, code] of cases) {
    await withApp({ od: { getSlots: async () => { throw thrown; } }, config: { ...BASE_CONFIG, readOnly: false } }, async (u) => {
      const res = await fetch(u("/available-slots"), { method: "POST", headers: H, body: JSON.stringify({ doctorId: "12", serviceId: "cleaning", date: "2027-01-05" }) });
      assert.equal(res.status, status);
      const text = await res.text();
      const j = JSON.parse(text);
      assert.equal(j.error, code);
      assert.equal(j.slots, undefined, "a failed calendar read NEVER returns slots (no mock fallback)");
      assert.ok(!text.includes("dev-key") && !text.includes("Jane Roe"), "no credentials or patient data in error responses");
    });
  }
});

// ── 11. No patient data leakage ──────────────────────────────────────────────

test("booking errors never echo the patient's details back", async () => {
  const od = { findOrCreatePatient: async () => { throw new OdError("od_http_error", 500); } };
  await withApp({ od, config: { ...BASE_CONFIG, readOnly: false } }, async (u) => {
    const res = await fetch(u("/create-appointment"), {
      method: "POST", headers: H,
      body: JSON.stringify({ name: "Jane Roe", phone: "+971501234567", email: "jane@example.com", doctorId: "12", serviceId: "cleaning", datetime: "2027-01-05T10:00" }),
    });
    assert.equal(res.status, 502);
    const text = await res.text();
    for (const secret of ["Jane", "Roe", "971501234567", "jane@example.com"]) {
      assert.ok(!text.includes(secret), `response must not contain "${secret}"`);
    }
  });
});

test("odDateTime converts ISO input to Open Dental's documented format", () => {
  assert.equal(odDateTime("2027-01-05T10:00"), "2027-01-05 10:00:00");
  assert.equal(odDateTime("2027-01-05T10:00:30"), "2027-01-05 10:00:00");
});

// ── 12. Existing mock smoke test still passes ────────────────────────────────

test("mock smoke test (full chain) still passes", async () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ["src/smoke.js"], { cwd: dir, env: { ...process.env, PORT: "4199" }, stdio: "ignore" });
    child.on("exit", resolve);
  });
  assert.equal(code, 0, "npm run smoke exits 0");
});
