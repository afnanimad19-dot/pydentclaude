// Canary guard + read-only transport — PURE OFFLINE tests (fake fetch only).
// Covers: target isolation, forbidden-project rejection (production first),
// local-credential refusal, proxy requirements, authorization failures and
// transport failure handling.
import { test } from "node:test";
import assert from "node:assert/strict";
import { okEnv, makeFakeFetch } from "./canary-fixtures.mjs";

const guard = await import("../scripts/canary-guard.ts");
const { createCanaryReadOnlyTransport, CANARY_REQUEST_HEADERS } = await import("../scripts/canary-transport.ts");
const a7guard = await import("@/lib/a7-guard");

const {
  CANARY_PROJECT_REF,
  CANARY_QUERY_ENDPOINT,
  FORBIDDEN_PRODUCTION_REF,
  FORBIDDEN_A7_REF,
  checkCanaryEnvironment,
  assertCanaryEndpoint,
  assertNoForbiddenRef,
  CanaryError,
} = guard;

const rejectsWith = (code) => (e) => e instanceof CanaryError && e.code === code;

// ------------------------------------------------------------ constants

test("canary target is hardcoded and the endpoint is built from it", () => {
  assert.equal(CANARY_PROJECT_REF, "thqjtoxzkujnljsmkwkp");
  assert.equal(CANARY_QUERY_ENDPOINT, "https://api.supabase.com/v1/projects/thqjtoxzkujnljsmkwkp/database/query");
});

test("forbidden refs equal the A7 guard's production and A7 constants", () => {
  assert.equal(FORBIDDEN_PRODUCTION_REF, "mzqynjywncbvqfikbzgm");
  assert.equal(FORBIDDEN_A7_REF, "etbuylimyelwoxxowtbx");
  assert.equal(FORBIDDEN_PRODUCTION_REF, a7guard.FORBIDDEN_PRODUCTION_REF);
  assert.equal(FORBIDDEN_A7_REF, a7guard.A7_PROJECT_REF);
  assert.notEqual(CANARY_PROJECT_REF, FORBIDDEN_PRODUCTION_REF);
  assert.notEqual(CANARY_PROJECT_REF, FORBIDDEN_A7_REF);
});

// ------------------------------------------------------------ environment guard

test("environment guard passes the minimal proxied environment", () => {
  assert.deepEqual(checkCanaryEnvironment(okEnv()), { ok: true, ref: CANARY_PROJECT_REF });
});

test("production ref anywhere in the env is refused, and outranks the A7 ref", () => {
  const r = checkCanaryEnvironment(okEnv({ SOME_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co`, OTHER: FORBIDDEN_A7_REF }));
  assert.equal(r.ok, false);
  assert.equal(r.code, "PRODUCTION_REF_BLOCKED");
  assert.match(r.detail, /SOME_URL/);
  assert.doesNotMatch(r.detail, /supabase\.co/, "detail names keys, never values");
});

test("A7 ref anywhere in the env is refused", () => {
  const r = checkCanaryEnvironment(okEnv({ NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_A7_REF}.supabase.co` }));
  assert.equal(r.code, "A7_REF_BLOCKED");
});

test("A7_MODE in the same process is refused", () => {
  assert.equal(checkCanaryEnvironment(okEnv({ A7_MODE: "1" })).code, "A7_MODE_SET");
});

test("locally visible Supabase credentials are refused (only the proxy secret may be used)", () => {
  for (const extra of [
    { SUPABASE_ACCESS_TOKEN: "x" },
    { SUPABASE_SERVICE_ROLE_KEY: "x" },
    { A7_SUPABASE_MGMT_TOKEN: "x" },
    { PGPASSWORD: "x" },
    { WHATEVER: "sbp_0123456789abcdef" },
    { DATABASE_URL: "postgresql://postgres:secret@db.example:5432/postgres" },
  ]) {
    const r = checkCanaryEnvironment(okEnv(extra));
    assert.equal(r.code, "LOCAL_SUPABASE_CREDENTIAL", JSON.stringify(Object.keys(extra)));
    assert.doesNotMatch(r.detail, /secret|sbp_0123/, "values never echoed");
  }
});

test("missing proxy or Node env-proxy flag is refused", () => {
  assert.equal(checkCanaryEnvironment({ NODE_USE_ENV_PROXY: "1" }).code, "PROXY_MISSING");
  assert.equal(checkCanaryEnvironment({ HTTPS_PROXY: "http://127.0.0.1:9" }).code, "NODE_ENV_PROXY_DISABLED");
  assert.equal(checkCanaryEnvironment({ https_proxy: "http://127.0.0.1:9", NODE_USE_ENV_PROXY: "1" }).ok, true);
});

test("endpoint assertion is byte-exact and rejects forbidden projects first", () => {
  assert.doesNotThrow(() => assertCanaryEndpoint(CANARY_QUERY_ENDPOINT));
  assert.throws(() => assertCanaryEndpoint(`${CANARY_QUERY_ENDPOINT}/`), rejectsWith("ENDPOINT_MISMATCH"));
  assert.throws(() => assertCanaryEndpoint(CANARY_QUERY_ENDPOINT.replace("https", "http")), rejectsWith("ENDPOINT_MISMATCH"));
  assert.throws(
    () => assertCanaryEndpoint(`https://api.supabase.com/v1/projects/${FORBIDDEN_A7_REF}/database/query`),
    rejectsWith("A7_REF_BLOCKED"),
  );
  assert.throws(
    () => assertCanaryEndpoint(`https://api.supabase.com/v1/projects/${FORBIDDEN_PRODUCTION_REF}/database/query`),
    rejectsWith("PRODUCTION_REF_BLOCKED"),
  );
  assert.throws(() => assertNoForbiddenRef(`x ${FORBIDDEN_A7_REF} ${FORBIDDEN_PRODUCTION_REF}`, "t"), rejectsWith("PRODUCTION_REF_BLOCKED"));
});

// ------------------------------------------------------------ transport: construction

test("transport refuses to construct under a bad environment — and never calls fetch", () => {
  const { fetchImpl, calls } = makeFakeFetch(() => ({ json: [] }));
  for (const [env, code] of [
    [okEnv({ X: FORBIDDEN_PRODUCTION_REF }), "PRODUCTION_REF_BLOCKED"],
    [okEnv({ X: FORBIDDEN_A7_REF }), "A7_REF_BLOCKED"],
    [okEnv({ A7_MODE: "1" }), "A7_MODE_SET"],
    [okEnv({ SUPABASE_ACCESS_TOKEN: "x" }), "LOCAL_SUPABASE_CREDENTIAL"],
    [{ NODE_USE_ENV_PROXY: "1" }, "PROXY_MISSING"],
  ]) {
    assert.throws(() => createCanaryReadOnlyTransport(env, fetchImpl), rejectsWith(code));
  }
  assert.equal(calls.length, 0);
});

test("transport exposes ONLY a read-only executor (no mutation member)", () => {
  const t = createCanaryReadOnlyTransport(okEnv(), makeFakeFetch(() => ({ json: [] })).fetchImpl);
  assert.deepEqual(Object.keys(t), ["executeReadOnlyQuery"]);
  assert.ok(Object.isFrozen(t));
});

// ------------------------------------------------------------ transport: requests

test("every request: pinned URL, POST, no Authorization header, read_only:true, redirects refused", async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => ({ json: [{ a: 1 }] }));
  const t = createCanaryReadOnlyTransport(okEnv(), fetchImpl);
  assert.deepEqual(await t.executeReadOnlyQuery("select 1 as a", [], "ctx"), [{ a: 1 }]);
  await t.executeReadOnlyQuery("select $1::text as a", ["p"], "ctx2");
  assert.equal(calls.length, 2);
  for (const c of calls) {
    assert.equal(c.url, CANARY_QUERY_ENDPOINT);
    assert.equal(c.init.method, "POST");
    assert.equal(c.init.redirect, "error");
    assert.deepEqual(c.init.headers, { ...CANARY_REQUEST_HEADERS });
    assert.ok(!Object.keys(c.init.headers).some((h) => h.toLowerCase() === "authorization"));
    assert.equal(c.body.read_only, true);
  }
  assert.equal("parameters" in calls[0].body, false, "no parameters key when none are bound");
  assert.deepEqual(calls[1].body.parameters, ["p"]);
});

test("SQL or parameters naming production or A7 are refused before fetch", async () => {
  const { fetchImpl, calls } = makeFakeFetch(() => ({ json: [] }));
  const t = createCanaryReadOnlyTransport(okEnv(), fetchImpl);
  await assert.rejects(t.executeReadOnlyQuery(`select '${FORBIDDEN_PRODUCTION_REF}'`, [], "c"), rejectsWith("PRODUCTION_REF_BLOCKED"));
  await assert.rejects(t.executeReadOnlyQuery("select $1", [FORBIDDEN_A7_REF], "c"), rejectsWith("A7_REF_BLOCKED"));
  await assert.rejects(t.executeReadOnlyQuery("   ", [], "c"), rejectsWith("SQL_INVALID"));
  await assert.rejects(t.executeReadOnlyQuery("select $1", [42], "c"), rejectsWith("SQL_INVALID"));
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------ transport: authorization + failure handling

test("HTTP 401 and 403 surface as AUTH_REJECTED with scrubbed detail", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = makeFakeFetch(() => ({
      status,
      text: '{"message":"Missing required permission(s): project_admin_read","token":"sbp_abcdefghijklmnop"}',
    }));
    const t = createCanaryReadOnlyTransport(okEnv(), fetchImpl);
    await assert.rejects(t.executeReadOnlyQuery("select 1", [], "auth-probe"), (e) => {
      assert.equal(e.code, "AUTH_REJECTED");
      assert.match(e.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(e.message, /sbp_abcdefghijklmnop/);
      return true;
    });
  }
});

test("other HTTP errors, network failures and malformed results fail closed", async () => {
  const cases = [
    [() => ({ status: 400, text: "ERROR: 42601 syntax error; Bearer abc.def" }), "TRANSPORT_HTTP_ERROR", /HTTP 400/],
    [() => { throw new Error(`connect to ${CANARY_QUERY_ENDPOINT} with Authorization: Bearer x`); }, "TRANSPORT_HTTP_ERROR", /network failure/],
    [() => ({ json: { not: "an array" } }), "RESULT_MALFORMED", /ctx/],
    [() => ({ unparseable: true }), "RESULT_MALFORMED", /unparseable/],
  ];
  for (const [respond, code, re] of cases) {
    const t = createCanaryReadOnlyTransport(okEnv(), makeFakeFetch(respond).fetchImpl);
    await assert.rejects(t.executeReadOnlyQuery("select 1", [], "ctx"), (e) => {
      assert.equal(e.code, code);
      assert.match(e.message, re);
      assert.doesNotMatch(e.message, /Bearer (abc|x)/);
      return true;
    });
  }
});
