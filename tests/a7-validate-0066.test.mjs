// Post-0066 read-only validator — PURE tests. fetch is ALWAYS an injected
// fake; no real network; fixture secrets only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { A7_PROJECT_REF, A7_SUPABASE_URL, FORBIDDEN_PRODUCTION_REF, A7GuardError } = await import("@/lib/a7-guard");
const { A7SentinelGuardError } = await import("@/lib/a7-sentinel-guard");
const { parseEnvA7, A7RunnerError, A7_AUTHORIZE_CONFIRMATION_PHRASE, A7_LIVE_CONFIRMATION_PHRASE } =
  await import("../scripts/a7-mutate-lib.ts");
const { createReadOnlyQueryTransport, createSentinelReadTransport } = await import("../scripts/a7-live-transport.ts");
const vlib = await import("../scripts/a7-validate-0066-lib.ts");
const { A7_POST0066_VALIDATION_SQL, EXPECTED_0066_COLUMNS, evaluatePost0066Row, runA7Post0066Validation } = vlib;
const { parseValidateCliArgs } = await import("../scripts/a7-validate-0066.ts");

const root = path.resolve(import.meta.dirname, "..");
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const FAKE_SENTINEL = "11111111-2222-4333-8444-555555555555";
const FAKE_MGMT = "sbp_FAKE_fixture_management_token_000";
const CONFIRM = A7_AUTHORIZE_CONFIRMATION_PHRASE;

const fakeEnv = () =>
  parseEnvA7(
    [
      "A7_MODE=1",
      `A7_EXPECTED_REF=${A7_PROJECT_REF}`,
      `NEXT_PUBLIC_SUPABASE_URL=${A7_SUPABASE_URL}`,
      `A7_SENTINEL_TOKEN=${FAKE_SENTINEL}`,
      `A7_SUPABASE_MGMT_TOKEN=${FAKE_MGMT}`,
    ].join("\n"),
  );

const goodRow = () => ({
  table_exists: true,
  cols_0066: [
    { name: "close_time", type: "text", default: "'17:00'::text" },
    { name: "closed_days", type: "text", default: "''::text" },
    { name: "default_duration_min", type: "integer", default: "30" },
    { name: "open_time", type: "text", default: "'09:00'::text" },
    { name: "slot_minutes", type: "integer", default: "30" },
  ],
  rls_enabled: true,
  policies: [{ name: "demo open access", cmd: "ALL", qual: "true", check: "true" }],
  owner: "postgres",
  anon_any_dml: false,
  auth_any_dml: false,
  service_role_any_dml: false,
});

/** Fake endpoint answering the sentinel probe and the validation query. */
const makeFakeEndpoint = ({ dbToken = FAKE_SENTINEL, row = goodRow() } = {}) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (body.query.includes("a7_guard.sentinel")) {
      const digest = body.parameters?.[0];
      return { ok: true, status: 201, text: async () => "", json: async () => [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: digest === sha256hex(dbToken.toLowerCase()) }] };
    }
    return { ok: true, status: 201, text: async () => "", json: async () => [row] };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
};

const wireDeps = (fetchImpl, overrides = {}) => {
  const env = overrides.env ?? fakeEnv();
  return {
    confirmation: CONFIRM,
    env,
    executeSentinelQuery: createSentinelReadTransport(fakeEnv(), fetchImpl).executeSentinelQuery,
    executeReadOnlyQuery: createReadOnlyQueryTransport(fakeEnv(), fetchImpl).executeReadOnlyQuery,
    ...overrides,
  };
};

test("happy path: sentinel then validation, every request read_only:true, all checks pass", async () => {
  const fetchImpl = makeFakeEndpoint();
  const result = await runA7Post0066Validation(wireDeps(fetchImpl));
  assert.equal(result.ok, true);
  assert.equal(result.ref, A7_PROJECT_REF);
  assert.ok(result.checks.length >= 15 && result.checks.every((c) => c.ok));
  assert.equal(fetchImpl.requests.length, 2, "sentinel + validation only");
  for (const { url, body } of fetchImpl.requests) {
    assert.ok(url.includes(A7_PROJECT_REF) && !url.includes(FORBIDDEN_PRODUCTION_REF));
    assert.equal(body.read_only, true, "every request is read_only:true");
  }
  assert.ok(fetchImpl.requests[0].body.query.includes("a7_guard.sentinel"), "sentinel verification first");
});

test("production target refused BEFORE any network use", async () => {
  const fetchImpl = makeFakeEndpoint();
  await assert.rejects(
    runA7Post0066Validation(wireDeps(fetchImpl, { env: { ...fakeEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` } })),
    (e) => e instanceof A7GuardError && e.code === "PRODUCTION_TARGET_BLOCKED",
  );
  assert.equal(fetchImpl.requests.length, 0);
});

test("wrong A7 identity refused before network", async () => {
  for (const [patch, code] of [
    [{ A7_EXPECTED_REF: "abcdefghij0123456789" }, "EXPECTED_REF_MISMATCH"],
    [{ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij0123456789.supabase.co" }, "REF_MISMATCH"],
    [{ A7_MODE: undefined }, "A7_MODE_MISSING"],
  ]) {
    const fetchImpl = makeFakeEndpoint();
    await assert.rejects(
      runA7Post0066Validation(wireDeps(fetchImpl, { env: { ...fakeEnv(), ...patch } })),
      (e) => e instanceof A7GuardError && e.code === code,
      code,
    );
    assert.equal(fetchImpl.requests.length, 0, `${code}: no fetch`);
  }
});

test("absent/wrong confirmation refused pre-network; mutation phrase does not satisfy it", async () => {
  for (const confirmation of [undefined, "", "yes", A7_LIVE_CONFIRMATION_PHRASE]) {
    const fetchImpl = makeFakeEndpoint();
    await assert.rejects(
      runA7Post0066Validation(wireDeps(fetchImpl, { confirmation })),
      (e) => e instanceof A7RunnerError && e.code === "AUTHORIZE_CONFIRMATION_REQUIRED",
      String(confirmation),
    );
    assert.equal(fetchImpl.requests.length, 0);
  }
});

test("sentinel failure stops validation: the validation query is never sent", async () => {
  const fetchImpl = makeFakeEndpoint({ dbToken: "99999999-8888-4777-a666-555555555544" });
  await assert.rejects(
    runA7Post0066Validation(wireDeps(fetchImpl)),
    (e) => e instanceof A7SentinelGuardError && e.code === "SENTINEL_TOKEN_MISMATCH",
  );
  assert.equal(fetchImpl.requests.length, 1, "only the sentinel request ran");
  assert.ok(fetchImpl.requests[0].body.query.includes("a7_guard.sentinel"));
});

test("schema / default / RLS / policy / ACL mismatches each fail closed with the check named", async () => {
  const cases = [
    ["missing column", (r) => { r.cols_0066 = r.cols_0066.slice(1); }, "all five 0066 columns present"],
    ["wrong type", (r) => { r.cols_0066[4].type = "text"; }, "slot_minutes: type integer"],
    ["wrong default", (r) => { r.cols_0066[3].default = "'08:00'::text"; }, "open_time: default"],
    ["RLS disabled", (r) => { r.rls_enabled = false; }, "RLS enabled"],
    ["extra policy", (r) => { r.policies.push({ name: "sneaky", cmd: "ALL", qual: "true", check: "true" }); }, "policies:"],
    ["policy renamed", (r) => { r.policies[0].name = "other"; }, "policies:"],
    ["service_role gained DML", (r) => { r.service_role_any_dml = true; }, "service_role DML posture"],
    ["anon gained DML", (r) => { r.anon_any_dml = true; }, "anon has no DML"],
    ["owner changed", (r) => { r.owner = "someone_else"; }, "owner is postgres"],
    ["table missing", (r) => { r.table_exists = false; }, "clinic_settings exists"],
  ];
  for (const [label, mutate, expectIn] of cases) {
    const row = goodRow();
    mutate(row);
    const fetchImpl = makeFakeEndpoint({ row });
    await assert.rejects(
      runA7Post0066Validation(wireDeps(fetchImpl)),
      (e) => e instanceof A7RunnerError && e.code === "VALIDATION_FAILED" && e.detail.includes(expectIn.split(":")[0]),
      label,
    );
  }
  // malformed result also fails closed
  assert.throws(() => evaluatePost0066Row("garbage"), (e) => e instanceof A7RunnerError && e.code === "VALIDATION_FAILED");
});

test("no mutation method or path is exposed anywhere in the validator", () => {
  // The read-only transport has exactly one capability.
  const t = createReadOnlyQueryTransport(fakeEnv(), makeFakeEndpoint());
  assert.deepEqual(Object.keys(t), ["executeReadOnlyQuery"]);
  assert.equal(t.executeMutation, undefined);
  // The validation SQL is a fixed, input-free SELECT with no DML/DDL.
  assert.match(A7_POST0066_VALIDATION_SQL, /^select /);
  // Statement forms only — the privilege-name literals inside
  // has_table_privilege('…','select,insert,update,delete') are arguments, not statements.
  assert.doesNotMatch(
    A7_POST0066_VALIDATION_SQL,
    /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\bcreate\s|\balter\s|\bdrop\s|\bgrant\s|\brevoke\s|\btruncate\b/i,
  );
  assert.ok(!A7_POST0066_VALIDATION_SQL.includes("$1"), "no bound inputs — nothing injectable");
  // Validator source references no mutation symbols (code only, comments/strings stripped).
  for (const file of ["scripts/a7-validate-0066.ts", "scripts/a7-validate-0066-lib.ts"]) {
    const code = fs
      .readFileSync(path.join(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const forbidden of ["executeMutation", "createLiveTransport", "runLiveStep", "A7_STEPS", "A7_LIVE_CONFIRMATION_PHRASE"]) {
      assert.ok(!code.includes(forbidden), `${file} must not reference ${forbidden}`);
    }
  }
  // Expected-state constants came from the migration files, not guesses.
  const mig = fs.readFileSync(path.join(root, "supabase", "migrations", "0066_clinic_scheduling.sql"), "utf8");
  for (const col of EXPECTED_0066_COLUMNS) assert.ok(mig.includes(col.name), col.name);
});

test("validator CLI accepts ONLY --confirm=<exact probe phrase>", () => {
  assert.deepEqual(parseValidateCliArgs([`--confirm=${CONFIRM}`]), { confirmation: CONFIRM });
  const refuse = (argv, code) =>
    assert.throws(() => parseValidateCliArgs(argv), (e) => e instanceof A7RunnerError && e.code === code, argv.join(" "));
  refuse([], "INVALID_ARGS");
  refuse(["--confirm=wrong"], "AUTHORIZE_CONFIRMATION_REQUIRED");
  refuse([`--confirm=${A7_LIVE_CONFIRMATION_PHRASE}`], "AUTHORIZE_CONFIRMATION_REQUIRED");
  refuse(["apply-0066", `--confirm=${CONFIRM}`], "INVALID_ARGS"); // no step argument exists
  refuse(["--sql=select 1"], "INVALID_ARGS");
  refuse([`--url=https://${FORBIDDEN_PRODUCTION_REF}.supabase.co`], "INVALID_ARGS");
  refuse([`--confirm=${CONFIRM}`, "extra"], "INVALID_ARGS");
});
