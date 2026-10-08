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

test("the transport exposes exactly runW1, runW2 and runW3 — no generic SQL interface", () => {
  const { fetchImpl } = probeFetch();
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  assert.deepEqual(Object.keys(t).sort(), ["runW1", "runW2", "runW3"]);
  assert.ok(Object.isFrozen(t));
  for (const member of [t.runW1, t.runW2, t.runW3]) assert.equal(member.length, 0, "probe members take no arguments");
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

// ------------------------------------------------------------ W3 failure-atomicity probe (offline)

const {
  CANARY_PROBE_W3_SQL,
  CANARY_W3_PROBE_SCHEMA,
  SQL_W3_ABSENCE_CHECK,
  PROPOSED_W3_CLEANUP_SQL,
  runCanaryW3Probe,
  runW3Cleanup,
} = lib;

const W3_ABSENT_ROW = { schema_absent: true, table_absent: true };

/** Read-only dispatcher for the W3 flow: blank fingerprint + scripted absence answers. */
const w3ReadOnly = ({ blank = [{ ...BLANK_ROW }], absence = [] } = {}) => {
  let absenceCalls = 0;
  const executor = async (sql) => {
    if (sql === SQL_PROBE_BLANK_FINGERPRINT) return structuredClone(blank);
    if (sql === SQL_W3_ABSENCE_CHECK) {
      const scripted = absence[Math.min(absenceCalls, absence.length - 1)] ?? { ...W3_ABSENT_ROW };
      absenceCalls += 1;
      return [structuredClone(scripted)];
    }
    throw new Error(`unexpected read-only SQL in W3 flow: ${sql.slice(0, 60)}`);
  };
  return { executor, absenceCallCount: () => absenceCalls };
};

const runW3 = (w3Response, readOnlyParts) => {
  const { fetchImpl, calls } = makeFakeFetch(async (body) => {
    assert.equal(body.query, CANARY_PROBE_W3_SQL, "only the frozen W3 SQL may reach the endpoint");
    assert.equal(body.read_only, false);
    return w3Response;
  });
  const probe = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  const ro = w3ReadOnly(readOnlyParts);
  return { calls, ro, report: runCanaryW3Probe({ env: okEnv(), readOnly: ro.executor, probe }) };
};

test("W3 SQL is frozen: dedicated schema, explicit transaction, guaranteed failure before commit", () => {
  assert.equal(CANARY_W3_PROBE_SCHEMA, "canary_probe_w3_atomicity");
  assert.match(CANARY_PROBE_W3_SQL, /^begin;/);
  assert.match(CANARY_PROBE_W3_SQL, /create schema canary_probe_w3_atomicity;/);
  assert.match(CANARY_PROBE_W3_SQL, /select 1\/0 as deliberate_failure;/);
  assert.ok(CANARY_PROBE_W3_SQL.indexOf("select 1/0") < CANARY_PROBE_W3_SQL.indexOf("commit;"), "the error precedes commit");
  assert.doesNotMatch(CANARY_PROBE_W3_SQL, /\b(drop|truncate|delete|update|grant|revoke)\b/i);
  // The probe schema is referenced by no migration and no app code path.
  assert.doesNotMatch(CANARY_PROBE_W3_SQL, /\b(public|a7_guard|canary_guard|supabase_migrations)\./);
});

test("W3 success: request fails, objects absent afterwards -> atomic rollback confirmed", async () => {
  const { calls, report } = runW3({ status: 400, text: "ERROR: division by zero" });
  const r = await report;
  assert.equal(r.outcome, "atomic_rollback_confirmed");
  assert.equal(r.atomicRollback, true);
  assert.equal(r.requestFailed, true);
  assert.equal(r.cleanupRequired, false);
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(calls.length, 1, "exactly one write-capable request");
});

test("W3 treats the SQL error as an outcome, not success: partial persistence is detected", async () => {
  const { report } = runW3({ status: 400, text: "ERROR: division by zero" }, {
    absence: [W3_ABSENT_ROW, { schema_absent: false, table_absent: false }],
  });
  const r = await report;
  assert.equal(r.outcome, "partial_persistence");
  assert.equal(r.atomicRollback, false);
  assert.equal(r.cleanupRequired, true, "cleanup proposal applies but is never executed");
  assert.ok(r.checks.some((c) => !c.ok));
});

test("W3 permission failure (401/403): reported, no atomicity conclusion", async () => {
  for (const status of [401, 403]) {
    const { report } = runW3({ status, text: "denied" });
    const r = await report;
    assert.equal(r.outcome, "not_authorized");
    assert.equal(r.atomicRollback, null);
    assert.equal(r.httpStatus, status);
    assert.equal(r.cleanupRequired, false);
  }
});

test("W3 unexpected success of the deliberately failing request is flagged, never treated as atomic", async () => {
  const { report } = runW3({ status: 200, json: [] }, { absence: [W3_ABSENT_ROW, { schema_absent: false, table_absent: false }] });
  const r = await report;
  assert.equal(r.outcome, "unexpected_success");
  assert.equal(r.atomicRollback, false);
  assert.equal(r.cleanupRequired, true);
});

test("W3 refuses to send anything when the probe schema already exists or the baseline is not blank", async () => {
  const present = runW3({ status: 400, text: "unreachable" }, { absence: [{ schema_absent: false, table_absent: true }] });
  await assert.rejects(present.report, probeStops("W3_SCHEMA_PRESENT"));
  assert.equal(present.calls.length, 0);
  const notBlank = runW3({ status: 400, text: "unreachable" }, { blank: [{ ...BLANK_ROW, public_relations: 2 }] });
  await assert.rejects(notBlank.report, probeStops("BASELINE_NOT_BLANK"));
  assert.equal(notBlank.calls.length, 0);
});

test("W3 malformed absence-check responses stop the probe", async () => {
  const { report } = runW3({ status: 400, text: "ERROR: division by zero" }, { absence: [{ nonsense: 1 }] });
  const r = report;
  await assert.rejects(r, probeStops("W3_SCHEMA_PRESENT")); // non-true booleans read as "not absent": fail closed before sending
});

test("W3 cleanup is refused by construction: no transport member accepts SQL and runW3Cleanup always throws", () => {
  assert.match(PROPOSED_W3_CLEANUP_SQL, /^drop schema if exists canary_probe_w3_atomicity cascade;$/);
  assert.throws(() => runW3Cleanup(), probeStops("W3_CLEANUP_NOT_AUTHORIZED"));
  const { fetchImpl, calls } = makeFakeFetch(async () => ({ json: [] }));
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  assert.ok(!Object.values(t).some((fn) => fn.length > 0), "no member takes SQL, so the cleanup text cannot be sent");
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------ CLI confirmation

test("the CLI requires the exact phrase for each mode and keeps them distinct", () => {
  assert.throws(() => cli.parseProbeCliArgs([]), guardStops("INVALID_ARGS"));
  assert.throws(() => cli.parseProbeCliArgs(["--confirm=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(() => cli.parseProbeCliArgs(["--confirm-w3=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(
    () => cli.parseProbeCliArgs([`--confirm=${cli.CANARY_PROBE_CONFIRMATION_PHRASE}`, "extra"]),
    guardStops("INVALID_ARGS"),
  );
  assert.throws(
    () => cli.parseProbeCliArgs([`--confirm=${cli.CANARY_W3_CONFIRMATION_PHRASE}`]),
    guardStops("CONFIRMATION_REQUIRED"),
    "the W3 phrase does not unlock W1/W2",
  );
  assert.throws(
    () => cli.parseProbeCliArgs([`--confirm-w3=${cli.CANARY_PROBE_CONFIRMATION_PHRASE}`]),
    guardStops("CONFIRMATION_REQUIRED"),
    "the W1/W2 phrase does not unlock W3",
  );
  assert.equal(cli.parseProbeCliArgs([`--confirm=${cli.CANARY_PROBE_CONFIRMATION_PHRASE}`]), "w1w2");
  assert.equal(cli.parseProbeCliArgs([`--confirm-w3=${cli.CANARY_W3_CONFIRMATION_PHRASE}`]), "w3");
});
