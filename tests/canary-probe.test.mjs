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

test("the transport surface is closed: six frozen operations plus the manifest-hash-gated migration sender", () => {
  const { fetchImpl } = probeFetch();
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  assert.deepEqual(Object.keys(t).sort(), [
    "runManifestMigration",
    "runP1Ddl",
    "runP1Insert",
    "runP2Hardening",
    "runValidationStatement",
    "runW1",
    "runW2",
    "runW3",
  ]);
  assert.ok(Object.isFrozen(t));
  for (const member of [t.runW1, t.runW2, t.runW3, t.runP1Ddl, t.runP2Hardening]) assert.equal(member.length, 0, "no argument accepted");
  assert.equal(t.runP1Insert.length, 1, "runP1Insert takes exactly the validated digest");
  assert.equal(t.runManifestMigration.length, 3, "runManifestMigration takes (rawSql, file, pinned hash), all hash-verified");
  assert.equal(t.runValidationStatement.length, 3, "runValidationStatement takes (frozen sql, shaped params, context)");
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

test("W3 cleanup is refused by construction: no member accepts SQL text and runW3Cleanup always throws", async () => {
  assert.match(PROPOSED_W3_CLEANUP_SQL, /^drop schema if exists canary_probe_w3_atomicity cascade;$/);
  assert.throws(() => runW3Cleanup(), probeStops("W3_CLEANUP_NOT_AUTHORIZED"));
  const { fetchImpl, calls } = makeFakeFetch(async () => ({ json: [] }));
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  // The one argument on the surface is runP1Insert's digest, which refuses SQL-shaped text.
  await assert.rejects(t.runP1Insert(PROPOSED_W3_CLEANUP_SQL), probeStops("P1_DIGEST_INVALID"));
  assert.equal(calls.length, 0);
});

// ------------------------------------------------------------ P1 sentinel setup (offline)

const sentinel = await import("../scripts/canary-sentinel.ts");
const { createHash } = await import("node:crypto");
const { FAKE_SENTINEL_TOKEN } = await import("./canary-fixtures.mjs");

const {
  P1_REQUEST_A_SQL,
  P1_REQUEST_B_SQL,
  SQL_P1_ACL_CHECK,
  deriveSentinelDigestFromEnv,
  runCanaryP1SentinelSetup,
} = lib;

const FAKE_DIGEST = createHash("sha256").update(FAKE_SENTINEL_TOKEN.toLowerCase(), "utf8").digest("hex");
const p1Env = (extra = {}) => okEnv({ CANARY_SENTINEL_TOKEN: FAKE_SENTINEL_TOKEN, ...extra });

const P1_ACL_OK_ROW = {
  anon_schema: false,
  authenticated_schema: false,
  service_role_schema: false,
  anon_table: false,
  authenticated_table: false,
  service_role_table: false,
  schema_owner: "postgres",
  table_owner: "postgres",
  no_default_acl_in_schema: true,
};
const SENTINEL_OK_ROW = { row_count: 1, id_ok: true, ref_ok: true, token_ok: true };
const PRESENT_ROW = { schema_present: true, table_present: true };
const ABSENT_PRESENCE_ROW = { schema_present: false, table_present: false };

/** Read-only dispatcher for the P1 flow; each scripted list repeats its last answer. */
const p1ReadOnly = ({
  blank = [{ ...BLANK_ROW }, { ...BLANK_ROW, sentinel_schema_absent: false }],
  presence = [ABSENT_PRESENCE_ROW, PRESENT_ROW],
  acl = [P1_ACL_OK_ROW],
  verification = [SENTINEL_OK_ROW],
} = {}) => {
  const counts = { blank: 0, presence: 0, acl: 0, verification: 0 };
  const next = (list, key) => {
    const v = list[Math.min(counts[key], list.length - 1)];
    counts[key] += 1;
    return [structuredClone(v)];
  };
  const executor = async (sql, params) => {
    if (sql === SQL_PROBE_BLANK_FINGERPRINT) return next(blank, "blank");
    if (sql === sentinel.SQL_SENTINEL_PRESENCE) return next(presence, "presence");
    if (sql === SQL_P1_ACL_CHECK) return next(acl, "acl");
    if (sql === sentinel.CANARY_SENTINEL_VERIFICATION_SQL) {
      assert.deepEqual(params, [FAKE_DIGEST], "verification binds the in-process digest");
      return next(verification, "verification");
    }
    throw new Error(`unexpected read-only SQL in P1 flow: ${sql.slice(0, 60)}`);
  };
  return { executor, counts };
};

const runP1 = ({ a = { json: [] }, b = { json: [] }, readOnlyParts, env = p1Env() } = {}) => {
  const { fetchImpl, calls } = makeFakeFetch(async (body) => {
    if (body.query === P1_REQUEST_A_SQL) {
      assert.ok(!("parameters" in body), "request A carries no parameters");
      return a;
    }
    if (body.query === P1_REQUEST_B_SQL) {
      assert.deepEqual(body.parameters, [FAKE_DIGEST], "request B binds exactly the digest");
      return b;
    }
    throw new Error(`unexpected SQL reached the fake endpoint: ${body.query.slice(0, 40)}`);
  });
  const probe = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  const ro = p1ReadOnly(readOnlyParts);
  return { calls, ro, report: runCanaryP1SentinelSetup({ env, readOnly: ro.executor, probe }) };
};

test("P1 reuses the committed sentinel proposal SQL verbatim and allowlists nothing else", () => {
  assert.equal(P1_REQUEST_A_SQL, sentinel.PROPOSED_CANARY_SENTINEL_DDL);
  assert.equal(P1_REQUEST_B_SQL, sentinel.PROPOSED_CANARY_SENTINEL_INSERT_SQL);
  assert.match(P1_REQUEST_A_SQL, /revoke all on schema canary_guard from public, anon, authenticated, service_role;/);
  assert.match(P1_REQUEST_A_SQL, /revoke all on table canary_guard\.sentinel from public, anon, authenticated, service_role;/);
  assert.doesNotMatch(P1_REQUEST_A_SQL, /\bgrant\b/i, "no grant to any role");
});

test("P1 digest derivation: env only, fail-closed on missing, malformed or exposed token", () => {
  assert.equal(deriveSentinelDigestFromEnv(p1Env()), FAKE_DIGEST);
  assert.throws(() => deriveSentinelDigestFromEnv(okEnv()), guardStops("SENTINEL_TOKEN_MISSING"));
  assert.throws(
    () => deriveSentinelDigestFromEnv(okEnv({ CANARY_SENTINEL_TOKEN: "not-a-uuid" })),
    guardStops("SENTINEL_TOKEN_MALFORMED"),
  );
  assert.throws(
    () => deriveSentinelDigestFromEnv(p1Env({ NEXT_PUBLIC_DEBUG: `x${FAKE_SENTINEL_TOKEN}y` })),
    guardStops("SENTINEL_TOKEN_EXPOSED"),
  );
});

test("P1 token failures stop before ANY request or query", async () => {
  const { calls, ro, report } = runP1({ env: okEnv() });
  await assert.rejects(report, guardStops("SENTINEL_TOKEN_MISSING"));
  assert.equal(calls.length, 0);
  assert.equal(Object.values(ro.counts).reduce((s, n) => s + n, 0), 0, "no read-only query either");
});

test("P1 happy path: A -> presence -> ACL posture -> B -> committed verification -> fingerprint", async () => {
  const { calls, report } = runP1();
  const r = await report;
  assert.equal(r.outcome, "sentinel_created");
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(calls.length, 2, "exactly two write-capable requests");
  assert.equal(calls[0].body.query, P1_REQUEST_A_SQL);
  assert.equal(calls[1].body.query, P1_REQUEST_B_SQL);
  for (const call of calls) {
    assert.equal(call.body.read_only, false);
    assert.deepEqual(Object.keys(call.init.headers), ["Content-Type"]);
  }
});

test("P1 refuses when the canary is not blank or the sentinel already exists; nothing is sent", async () => {
  const notBlank = runP1({ readOnlyParts: { blank: [{ ...BLANK_ROW, public_relations: 1 }] } });
  await assert.rejects(notBlank.report, probeStops("BASELINE_NOT_BLANK"));
  assert.equal(notBlank.calls.length, 0);
  const present = runP1({ readOnlyParts: { presence: [PRESENT_ROW] } });
  await assert.rejects(present.report, probeStops("P1_ALREADY_PRESENT"));
  assert.equal(present.calls.length, 0);
});

test("P1 permission failure on request A: reported, request B never sent", async () => {
  for (const status of [401, 403]) {
    const { calls, report } = runP1({ a: { status, text: "denied" } });
    const r = await report;
    assert.equal(r.outcome, "not_authorized");
    assert.equal(r.httpStatusA, status);
    assert.equal(calls.length, 1, "only request A was sent");
  }
});

test("P1 partial setup (DDL accepted but objects not visible) stops before the insert", async () => {
  const { calls, report } = runP1({ readOnlyParts: { presence: [ABSENT_PRESENCE_ROW, ABSENT_PRESENCE_ROW] } });
  await assert.rejects(report, probeStops("P1_DDL_NOT_VISIBLE"));
  assert.equal(calls.length, 1, "the insert was never sent");
});

test("P1 verifies the ACTUAL ACL posture and stops on any surprise before the insert", async () => {
  for (const bad of [
    { ...P1_ACL_OK_ROW, service_role_table: true },
    { ...P1_ACL_OK_ROW, anon_schema: true },
    { ...P1_ACL_OK_ROW, table_owner: "supabase_admin" },
    { ...P1_ACL_OK_ROW, no_default_acl_in_schema: false },
  ]) {
    const { calls, report } = runP1({ readOnlyParts: { acl: [bad] } });
    await assert.rejects(report, probeStops("P1_ACL_UNEXPECTED"));
    assert.equal(calls.length, 1, "the insert was never sent");
  }
});

test("P1 mismatched digest: the committed verification gate refuses and the run fails closed", async () => {
  const { report } = runP1({ readOnlyParts: { verification: [{ ...SENTINEL_OK_ROW, token_ok: false }] } });
  let thrown;
  try {
    await report;
  } catch (e) {
    thrown = e;
  }
  assert.ok(guardStops("SENTINEL_TOKEN_MISMATCH")(thrown));
  assert.ok(!thrown.message.includes(FAKE_SENTINEL_TOKEN), "the token never appears in a message");
  assert.ok(!thrown.message.includes(FAKE_DIGEST), "the digest never appears in a message");
});

test("P1 insert failure is a fixed-detail stop with no retry and no body text surfaced", async () => {
  const { calls, report } = runP1({ b: { status: 500, text: `boom ${FAKE_DIGEST}` } });
  let thrown;
  try {
    await report;
  } catch (e) {
    thrown = e;
  }
  assert.ok(probeStops("PROBE_HTTP_ERROR")(thrown));
  assert.ok(!thrown.message.includes(FAKE_DIGEST), "response text is not surfaced on the insert path");
  assert.equal(calls.length, 2, "no retry");
});

test("P1 transport isolation: the digest argument refuses anything that is not 64-hex", async () => {
  const { fetchImpl, calls } = makeFakeFetch(async () => ({ json: [] }));
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  for (const bad of ["", "abc", FAKE_SENTINEL_TOKEN, `${FAKE_DIGEST}ff`, FAKE_DIGEST.toUpperCase(), "drop schema x;"]) {
    await assert.rejects(t.runP1Insert(bad), probeStops("P1_DIGEST_INVALID"));
  }
  assert.equal(calls.length, 0, "nothing reached the endpoint");
});

// ------------------------------------------------------------ P2 privilege hardening (offline)

const plan = await import("../scripts/canary-plan-lib.ts");
const { P2_HARDENING_SQL, SQL_P2_ACL_DETAIL, SQL_P2_ACL_GLOBAL, runCanaryP2Hardening } = lib;

const aclRow = (owner, objtype, grantee, privilege_type) => ({ owner, objtype, grantee, privilege_type });
const PERMISSIVE_DETAIL = [
  ...["anon", "authenticated", "service_role"].flatMap((g) => [aclRow("postgres", "r", g, "SELECT"), aclRow("postgres", "S", g, "USAGE")]),
  aclRow("postgres", "f", "anon", "EXECUTE"),
  aclRow("supabase_admin", "r", "anon", "SELECT"),
];
const HARDENED_DETAIL = [aclRow("postgres", "f", "anon", "EXECUTE"), aclRow("supabase_admin", "r", "anon", "SELECT")];
const READINESS_CLEAN = [
  { objtype: "f", owner: "postgres", api_role_grantees: "anon" },
  { objtype: "r", owner: "supabase_admin", api_role_grantees: "anon" },
];
const P2_BLANK_ROW = { ...BLANK_ROW, sentinel_schema_absent: false };

/** Read-only dispatcher for the P2 flow; each scripted list repeats its last answer. */
const p2ReadOnly = ({
  blank = [P2_BLANK_ROW],
  detail = [PERMISSIVE_DETAIL, HARDENED_DETAIL],
  global: globalAcl = [[]],
  readiness = [READINESS_CLEAN],
  verification = [SENTINEL_OK_ROW],
} = {}) => {
  const counts = { blank: 0, detail: 0, global: 0, readiness: 0, verification: 0 };
  const one = (list, key) => {
    const v = list[Math.min(counts[key], list.length - 1)];
    counts[key] += 1;
    return structuredClone(Array.isArray(v) ? v : [v]);
  };
  const executor = async (sql, params) => {
    if (sql === SQL_PROBE_BLANK_FINGERPRINT) return one(blank, "blank");
    if (sql === SQL_P2_ACL_DETAIL) return one(detail, "detail");
    if (sql === SQL_P2_ACL_GLOBAL) return one(globalAcl, "global");
    if (sql === plan.SQL_DEFAULT_ACL_API_ROLE_GRANTS) return one(readiness, "readiness");
    if (sql === sentinel.CANARY_SENTINEL_VERIFICATION_SQL) {
      assert.deepEqual(params, [FAKE_DIGEST], "the sentinel gate binds the in-process digest");
      return one(verification, "verification");
    }
    throw new Error(`unexpected read-only SQL in P2 flow: ${sql.slice(0, 60)}`);
  };
  return { executor, counts };
};

const runP2 = ({ response = { json: [] }, readOnlyParts, env = p1Env() } = {}) => {
  const { fetchImpl, calls } = makeFakeFetch(async (body) => {
    assert.equal(body.query, P2_HARDENING_SQL, "only the frozen P2 SQL may reach the endpoint");
    assert.equal(body.read_only, false);
    assert.ok(!("parameters" in body), "the hardening request carries no parameters");
    return response;
  });
  const probe = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  const ro = p2ReadOnly(readOnlyParts);
  return { calls, ro, report: runCanaryP2Hardening({ env, readOnly: ro.executor, probe }) };
};

test("P2 reuses the reviewed hardening proposal verbatim: one transaction, revokes only", () => {
  assert.equal(P2_HARDENING_SQL, plan.PROPOSED_PRIVILEGE_HARDENING_SQL);
  assert.match(P2_HARDENING_SQL, /^begin;/);
  assert.match(P2_HARDENING_SQL, /revoke all on tables from anon, authenticated, service_role;/);
  assert.match(P2_HARDENING_SQL, /revoke all on sequences from anon, authenticated, service_role;/);
  assert.match(P2_HARDENING_SQL, /commit;$/);
  assert.doesNotMatch(P2_HARDENING_SQL, /\b(grant|drop|truncate|delete|insert|update|create)\b/i);
  assert.doesNotMatch(P2_HARDENING_SQL, /\bfunctions\b/i, "function defaults are deliberately out of scope");
});

test("P2 happy path: sentinel gate -> baseline ACLs -> one request -> full post verification", async () => {
  const { calls, report } = runP2();
  const r = await report;
  assert.equal(r.outcome, "hardened");
  assert.ok(r.checks.every((c) => c.ok));
  assert.equal(calls.length, 1, "exactly one write-capable request");
});

test("P2 sentinel gate failures stop before any write", async () => {
  const mismatch = runP2({ readOnlyParts: { verification: [{ ...SENTINEL_OK_ROW, token_ok: false }] } });
  await assert.rejects(mismatch.report, guardStops("SENTINEL_TOKEN_MISMATCH"));
  assert.equal(mismatch.calls.length, 0);
  const noToken = runP2({ env: okEnv() });
  await assert.rejects(noToken.report, guardStops("SENTINEL_TOKEN_MISSING"));
  assert.equal(noToken.calls.length, 0);
});

test("P2 refuses when public is not blank or history is not empty", async () => {
  const { calls, report } = runP2({ readOnlyParts: { blank: [{ ...P2_BLANK_ROW, migration_rows: 3 }] } });
  await assert.rejects(report, probeStops("BASELINE_NOT_BLANK"));
  assert.equal(calls.length, 0);
});

test("P2 refuses when the baseline ACLs are not the known permissive posture", async () => {
  const { calls, report } = runP2({ readOnlyParts: { detail: [HARDENED_DETAIL] } });
  await assert.rejects(report, probeStops("P2_BASELINE_ACL_UNEXPECTED"));
  assert.equal(calls.length, 0);
});

test("P2 refuses when a global default ACL exists (schema-scoped revokes would not cover it)", async () => {
  const { calls, report } = runP2({ readOnlyParts: { global: [[aclRow("postgres", "r", "anon", "SELECT")]] } });
  await assert.rejects(report, probeStops("P2_GLOBAL_ACL_PRESENT"));
  assert.equal(calls.length, 0);
});

test("P2 permission failure (401/403): reported, nothing further", async () => {
  for (const status of [401, 403]) {
    const { calls, report } = runP2({ response: { status, text: "denied" } });
    const r = await report;
    assert.equal(r.outcome, "not_authorized");
    assert.equal(r.httpStatus, status);
    assert.equal(calls.length, 1);
  }
});

test("P2 HTTP failure stops with a scrubbed fixed detail and no retry", async () => {
  const { calls, report } = runP2({ response: { status: 500, text: "boom" } });
  await assert.rejects(report, probeStops("PROBE_HTTP_ERROR"));
  assert.equal(calls.length, 1, "no retry");
});

test("P2 detects incomplete hardening: surviving API table/sequence defaults fail the run", async () => {
  const stillPermissive = [...HARDENED_DETAIL, aclRow("postgres", "r", "service_role", "INSERT")];
  const { report } = runP2({ readOnlyParts: { detail: [PERMISSIVE_DETAIL, stillPermissive] } });
  await assert.rejects(report, probeStops("P2_HARDENING_INCOMPLETE"));
});

test("P2 detects out-of-scope drift: postgres function or supabase_admin defaults must be unchanged", async () => {
  const fDropped = [aclRow("supabase_admin", "r", "anon", "SELECT")];
  const { report } = runP2({ readOnlyParts: { detail: [PERMISSIVE_DETAIL, fDropped] } });
  await assert.rejects(report, probeStops("P2_UNRELATED_ACL_CHANGED"));
  const adminChanged = [aclRow("postgres", "f", "anon", "EXECUTE"), aclRow("supabase_admin", "r", "anon", "DELETE")];
  const { report: r2 } = runP2({ readOnlyParts: { detail: [PERMISSIVE_DETAIL, adminChanged] } });
  await assert.rejects(r2, probeStops("P2_UNRELATED_ACL_CHANGED"));
});

test("P2 detects a global default ACL appearing after the request", async () => {
  const { report } = runP2({ readOnlyParts: { global: [[], [aclRow("postgres", "r", "anon", "SELECT")]] } });
  await assert.rejects(report, probeStops("P2_GLOBAL_ACL_PRESENT"));
});

test("P2 fails closed when the committed readiness query still shows API grantees", async () => {
  const dirty = [...READINESS_CLEAN, { objtype: "r", owner: "postgres", api_role_grantees: "service_role" }];
  const { report } = runP2({ readOnlyParts: { readiness: [dirty] } });
  await assert.rejects(report, probeStops("P2_HARDENING_INCOMPLETE"));
});

// ------------------------------------------------------------ P3 migration transport (offline)

const fs = await import("node:fs");
const path = await import("node:path");
const manifest = await import("../scripts/a7-manifest.ts");

const MIG_DIR = path.join(import.meta.dirname, "..", "supabase", "migrations");
const FIRST_MIG = manifest.A7_STEPS["baseline-0001-0064"].migrations[0];
const FIRST_MIG_RAW = fs.readFileSync(path.join(MIG_DIR, FIRST_MIG.file), "utf8");

test("runManifestMigration sends one pinned file wrapped in begin/commit, read_only:false, no parameters", async () => {
  const { fetchImpl, calls } = makeFakeFetch(async () => ({ json: [] }));
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  const r = await t.runManifestMigration(FIRST_MIG_RAW, FIRST_MIG.file, FIRST_MIG.sha256);
  assert.deepEqual(r, { authorized: true, httpStatus: 200 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.query, plan.wrapInTransaction(FIRST_MIG_RAW));
  assert.equal(calls[0].body.read_only, false);
  assert.ok(!("parameters" in calls[0].body));
  assert.deepEqual(Object.keys(calls[0].init.headers), ["Content-Type"]);
});

test("runManifestMigration refuses tampered SQL, unknown files, unpinned hashes and cleanup text", async () => {
  const { fetchImpl, calls } = makeFakeFetch(async () => ({ json: [] }));
  const t = createCanaryWriteProbeTransport(okEnv(), fetchImpl);
  await assert.rejects(t.runManifestMigration(`${FIRST_MIG_RAW}\n-- tampered`, FIRST_MIG.file, FIRST_MIG.sha256), probeStops("P3_FILE_HASH_MISMATCH"));
  await assert.rejects(t.runManifestMigration(FIRST_MIG_RAW, "9999_not_real.sql", FIRST_MIG.sha256), probeStops("P3_FILE_NOT_IN_MANIFEST"));
  await assert.rejects(t.runManifestMigration(FIRST_MIG_RAW, FIRST_MIG.file, FAKE_DIGEST), probeStops("P3_FILE_NOT_IN_MANIFEST"));
  await assert.rejects(t.runManifestMigration(PROPOSED_W3_CLEANUP_SQL, FIRST_MIG.file, FIRST_MIG.sha256), probeStops("P3_FILE_HASH_MISMATCH"));
  assert.equal(calls.length, 0, "nothing reached the endpoint");
});

test("runManifestMigration resolves authorized:false on 401/403 and throws scrubbed on other HTTP failures", async () => {
  const denied = createCanaryWriteProbeTransport(okEnv(), makeFakeFetch(async () => ({ status: 403, text: "denied" })).fetchImpl);
  assert.deepEqual(await denied.runManifestMigration(FIRST_MIG_RAW, FIRST_MIG.file, FIRST_MIG.sha256), { authorized: false, httpStatus: 403 });
  const broken = createCanaryWriteProbeTransport(okEnv(), makeFakeFetch(async () => ({ status: 500, text: "boom" })).fetchImpl);
  await assert.rejects(broken.runManifestMigration(FIRST_MIG_RAW, FIRST_MIG.file, FIRST_MIG.sha256), probeStops("PROBE_HTTP_ERROR"));
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
  assert.throws(() => cli.parseProbeCliArgs(["--confirm-p1=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(
    () => cli.parseProbeCliArgs([`--confirm-p1=${cli.CANARY_W3_CONFIRMATION_PHRASE}`]),
    guardStops("CONFIRMATION_REQUIRED"),
    "the W3 phrase does not unlock P1",
  );
  assert.throws(
    () => cli.parseProbeCliArgs([`--confirm=${cli.CANARY_P1_CONFIRMATION_PHRASE}`]),
    guardStops("CONFIRMATION_REQUIRED"),
    "the P1 phrase does not unlock W1/W2",
  );
  assert.throws(() => cli.parseProbeCliArgs(["--confirm-p2=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(
    () => cli.parseProbeCliArgs([`--confirm-p2=${cli.CANARY_P1_CONFIRMATION_PHRASE}`]),
    guardStops("CONFIRMATION_REQUIRED"),
    "the P1 phrase does not unlock P2",
  );
  assert.throws(
    () => cli.parseProbeCliArgs([`--confirm-p1=${cli.CANARY_P2_CONFIRMATION_PHRASE}`]),
    guardStops("CONFIRMATION_REQUIRED"),
    "the P2 phrase does not unlock P1",
  );
  assert.equal(cli.parseProbeCliArgs([`--confirm=${cli.CANARY_PROBE_CONFIRMATION_PHRASE}`]), "w1w2");
  assert.equal(cli.parseProbeCliArgs([`--confirm-w3=${cli.CANARY_W3_CONFIRMATION_PHRASE}`]), "w3");
  assert.equal(cli.parseProbeCliArgs([`--confirm-p1=${cli.CANARY_P1_CONFIRMATION_PHRASE}`]), "p1");
  assert.equal(cli.parseProbeCliArgs([`--confirm-p2=${cli.CANARY_P2_CONFIRMATION_PHRASE}`]), "p2");
});
