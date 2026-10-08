// Canary W1/W2 write-capability probe — PURE OFFLINE tests (fake fetch only).
// Covers: guard enforcement at construction, the frozen-SQL-only surface,
// exact request bodies (read_only:false, no parameters, no auth header),
// the W1 authorization finding (401/403 ends the probe without W2), the
// role/transaction gates, W2 rollback confirmation, baseline and post-probe
// blank verification, and stop-on-first-surprise ordering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { okEnv, makeFakeFetch } from "./canary-fixtures.mjs";

const guard = await import("../scripts/canary-guard.ts");
const lib = await import("../scripts/canary-probe-lib.ts");
const cli = await import("../scripts/canary-probe.ts");

const {
  CANARY_PROBE_W1_SQL,
  CANARY_PROBE_W2_SQL,
  SQL_PROBE_BLANK_FINGERPRINT,
  EXPECTED_WRITE_PATH_ROLE,
  CanaryProbeError,
  createCanaryWriteProbeTransport,
  runCanaryWriteProbe,
} = lib;

const probeStops = (code) => (e) => e instanceof CanaryProbeError && e.code === code;
const guardStops = (code) => (e) => e instanceof guard.CanaryError && e.code === code;

const BLANK_ROW = {
  public_relations: 0,
  public_functions: 0,
  public_types: 0,
  migration_rows: 0,
  sentinel_schema_absent: true,
  no_persisted_probe_table: true,
};
const W1_OK_ROW = {
  role_name: "postgres",
  session_role: "postgres",
  transaction_read_only: "off",
  default_transaction_read_only: "off",
  server_version_num: "170011",
};
const W2_OK_ROW = { temp_table_gone: true, guc_reverted: true };

/** Read-only executor stub answering only the blank fingerprint. */
const blankReadOnly =
  (rows = [{ ...BLANK_ROW }]) =>
  async (sql) => {
    assert.equal(sql, SQL_PROBE_BLANK_FINGERPRINT, "probe uses only the fixed read-only fingerprint SQL");
    return structuredClone(rows);
  };

/** Fake fetch answering W1 and W2 from a script of responses. */
const probeFetch = (w1 = { json: [W1_OK_ROW] }, w2 = { json: [W2_OK_ROW] }) =>
  makeFakeFetch(async (body) => {
    if (body.query === CANARY_PROBE_W1_SQL) return w1;
    if (body.query === CANARY_PROBE_W2_SQL) return w2;
    throw new Error(`unexpected SQL reached the fake endpoint: ${body.query.slice(0, 40)}`);
  });

// ------------------------------------------------------------ frozen surface

test("the probe SQL is frozen: W1 is SELECT-only, W2 is temp-and-rollback only", () => {
  assert.match(CANARY_PROBE_W1_SQL, /^select /);
  assert.doesNotMatch(CANARY_PROBE_W1_SQL, /\b(create|insert|update|delete|drop|truncate|alter|grant|revoke)\b/i);
  assert.match(CANARY_PROBE_W2_SQL, /^begin;/);
  assert.match(CANARY_PROBE_W2_SQL, /create temporary table canary_write_probe_tmp/);
  assert.match(CANARY_PROBE_W2_SQL, /rollback;/);
  assert.doesNotMatch(CANARY_PROBE_W2_SQL, /\bcommit\b/i);
  assert.doesNotMatch(CANARY_PROBE_W2_SQL, /\b(drop|truncate|delete|update|grant|revoke|alter)\b/i);
  for (const sql of [CANARY_PROBE_W1_SQL, CANARY_PROBE_W2_SQL]) {
    assert.ok(!sql.includes(guard.FORBIDDEN_PRODUCTION_REF) && !sql.includes(guard.FORBIDDEN_A7_REF));
  }
});

test("the transport exposes exactly runW1 and runW2 — no generic SQL interface", () => {
  const { fetchImpl } = probeFetch();
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  assert.deepEqual(Object.keys(t).sort(), ["runW1", "runW2"]);
  assert.ok(Object.isFrozen(t));
  assert.equal(t.runW1.length, 0, "runW1 takes no arguments");
  assert.equal(t.runW2.length, 0, "runW2 takes no arguments");
});

// ------------------------------------------------------------ guard at construction

test("construction refuses a forbidden ref in the environment (production first)", () => {
  assert.throws(
    () => createCanaryWriteProbeTransport(okEnv({ X: guard.FORBIDDEN_PRODUCTION_REF, Y: guard.FORBIDDEN_A7_REF })),
    guardStops("PRODUCTION_REF_BLOCKED"),
  );
  assert.throws(() => createCanaryWriteProbeTransport(okEnv({ Y: guard.FORBIDDEN_A7_REF })), guardStops("A7_REF_BLOCKED"));
});

test("construction refuses a locally visible Supabase credential and a missing proxy", () => {
  assert.throws(
    () => createCanaryWriteProbeTransport(okEnv({ SUPABASE_SERVICE_KEY: "sbp_0123456789abcdef" })),
    guardStops("LOCAL_SUPABASE_CREDENTIAL"),
  );
  assert.throws(() => createCanaryWriteProbeTransport({ NODE_USE_ENV_PROXY: "1" }), guardStops("PROXY_MISSING"));
});

// ------------------------------------------------------------ request shape

test("W1 and W2 post read_only:false frozen SQL to the pinned endpoint with no auth header", async () => {
  const { fetchImpl, calls } = probeFetch();
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  await t.runW1();
  await t.runW2();
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, guard.CANARY_QUERY_ENDPOINT);
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.redirect, "error");
    assert.deepEqual(Object.keys(call.init.headers), ["Content-Type"], "Content-Type is the only header");
    assert.equal(call.body.read_only, false);
    assert.ok(!("parameters" in call.body));
  }
  assert.equal(calls[0].body.query, CANARY_PROBE_W1_SQL);
  assert.equal(calls[1].body.query, CANARY_PROBE_W2_SQL);
});

// ------------------------------------------------------------ W1 outcomes

test("W1 parses the identity row when the write path is authorized", async () => {
  const { fetchImpl } = probeFetch();
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  const r = await t.runW1();
  assert.equal(r.authorized, true);
  assert.equal(r.row.role_name, EXPECTED_WRITE_PATH_ROLE);
});

test("W1 resolves authorized:false on 401/403 instead of throwing", async () => {
  for (const status of [401, 403]) {
    const { fetchImpl } = probeFetch({ status, text: "denied" });
    const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
    const r = await t.runW1();
    assert.deepEqual(r, { authorized: false, httpStatus: status });
  }
});

test("W1 throws PROBE_HTTP_ERROR on other HTTP failures and PROBE_RESULT_MALFORMED on bad rows", async () => {
  const bad = createCanaryWriteProbeTransport(okEnv(), probeFetch({ status: 500, text: "boom" }).fetchImpl);
  await assert.rejects(bad.runW1(), probeStops("PROBE_HTTP_ERROR"));
  const malformed = createCanaryWriteProbeTransport(okEnv(), probeFetch({ json: { not: "an array" } }).fetchImpl);
  await assert.rejects(malformed.runW1(), probeStops("PROBE_RESULT_MALFORMED"));
});

// ------------------------------------------------------------ orchestration

const run = (fetchParts, readOnly = blankReadOnly()) => {
  const { fetchImpl, calls } = probeFetch(...fetchParts);
  const probe = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  return { calls, report: runCanaryWriteProbe({ env: okEnv(), readOnly, probe }) };
};

test("happy path: baseline -> W1 -> W2 -> verification, canary unchanged", async () => {
  const { calls, report } = run([]);
  const r = await report;
  assert.equal(r.completed, true);
  assert.deepEqual(r.w1, {
    authorized: true,
    roleName: "postgres",
    sessionRole: "postgres",
    transactionReadOnly: "off",
    defaultTransactionReadOnly: "off",
  });
  assert.deepEqual(r.w2, { tempTableGone: true, gucReverted: true });
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(calls.length, 2, "exactly two write-capable requests were sent");
});

test("a non-blank baseline stops the probe before any write-capable request", async () => {
  const notBlank = blankReadOnly([{ ...BLANK_ROW, public_relations: 3 }]);
  const { calls, report } = run([], notBlank);
  await assert.rejects(report, probeStops("BASELINE_NOT_BLANK"));
  assert.equal(calls.length, 0, "no probe request was sent");
});

test("W1 not authorized (403) is a conclusive finding: reported, W2 never sent", async () => {
  const { calls, report } = run([[{ status: 403, text: "denied" }][0]]);
  const r = await report;
  assert.equal(r.completed, true);
  assert.deepEqual(r.w1, { authorized: false, httpStatus: 403 });
  assert.equal(r.w2, null);
  assert.equal(calls.length, 1, "only W1 was sent");
});

test("an unexpected executing role stops the probe before W2", async () => {
  const { calls, report } = run([{ json: [{ ...W1_OK_ROW, role_name: "supabase_read_only_user", session_role: "supabase_read_only_user" }] }]);
  await assert.rejects(report, probeStops("W1_ROLE_UNEXPECTED"));
  assert.equal(calls.length, 1, "W2 was never sent");
});

test("an unexpected transaction state stops the probe before W2", async () => {
  const { calls, report } = run([{ json: [{ ...W1_OK_ROW, transaction_read_only: "on" }] }]);
  await assert.rejects(report, probeStops("W1_TX_STATE_UNEXPECTED"));
  assert.equal(calls.length, 1, "W2 was never sent");
});

test("W2 without confirmed rollback stops the probe", async () => {
  for (const row of [{ temp_table_gone: false, guc_reverted: true }, { temp_table_gone: true, guc_reverted: false }]) {
    const { report } = run([undefined, { json: [row] }]);
    await assert.rejects(report, probeStops("W2_ROLLBACK_NOT_CONFIRMED"));
  }
});

test("a changed post-probe fingerprint stops the probe", async () => {
  let reads = 0;
  const readOnly = async (sql) => {
    assert.equal(sql, SQL_PROBE_BLANK_FINGERPRINT);
    reads += 1;
    return reads === 1 ? [{ ...BLANK_ROW }] : [{ ...BLANK_ROW, no_persisted_probe_table: false }];
  };
  const { report } = run([], readOnly);
  await assert.rejects(report, probeStops("STATE_CHANGED_AFTER_PROBE"));
  assert.equal(reads, 2);
});

// ------------------------------------------------------------ CLI confirmation

test("the CLI requires its exact confirmation phrase", () => {
  assert.throws(() => cli.parseProbeCliArgs([]), guardStops("INVALID_ARGS"));
  assert.throws(() => cli.parseProbeCliArgs(["--confirm=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(
    () => cli.parseProbeCliArgs([`--confirm=${cli.CANARY_PROBE_CONFIRMATION_PHRASE}`, "extra"]),
    guardStops("INVALID_ARGS"),
  );
  cli.parseProbeCliArgs([`--confirm=${cli.CANARY_PROBE_CONFIRMATION_PHRASE}`]);
});
