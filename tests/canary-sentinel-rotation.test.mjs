// Canary sentinel ROTATION (Step 72C.14) — PURE OFFLINE tests (fake fetch and
// fake read-only executor only; no network, no database).
// Covers: the exact approved compare-and-swap text, two-digest binding and the
// request shape, refusal of malformed/identical/extra parameters, isolation
// from the frozen-SQL / P9 / manifest paths, the 401/403 finding, zero-row and
// unexpected-row outcomes, transport failures (no retry; fixed recovery
// guidance), post-request old/new token verification, inventory and ACL
// posture invariance, production/A7 ref rejection, the read-only status
// reading, the CLI phrases, and that no token or digest ever leaks into a
// report, check, error message or guidance string.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { okEnv, makeFakeFetch, FAKE_SENTINEL_TOKEN } from "./canary-fixtures.mjs";

const guard = await import("../scripts/canary-guard.ts");
const sentinel = await import("../scripts/canary-sentinel.ts");
const pre = await import("../scripts/canary-preflight-lib.ts");
const lib = await import("../scripts/canary-probe-lib.ts");
const cli = await import("../scripts/canary-probe.ts");

const {
  CanaryProbeError,
  PR_REQUEST_SQL,
  SQL_P1_ACL_CHECK,
  ROTATION_RECOVERY_GUIDANCE,
  createCanaryWriteProbeTransport,
  deriveNextSentinelDigestFromEnv,
  runCanarySentinelRotation,
  runCanarySentinelRotationStatus,
} = lib;

const probeStops = (code) => (e) => e instanceof CanaryProbeError && e.code === code;
const guardStops = (code) => (e) => e instanceof guard.CanaryError && e.code === code;

const digestOf = (token) => createHash("sha256").update(token.toLowerCase(), "utf8").digest("hex");
const CURRENT_TOKEN = FAKE_SENTINEL_TOKEN;
const NEXT_TOKEN = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const THIRD_TOKEN = "99999999-8888-4777-8666-555555555555";
const CURRENT_DIGEST = digestOf(CURRENT_TOKEN);
const NEXT_DIGEST = digestOf(NEXT_TOKEN);
const THIRD_DIGEST = digestOf(THIRD_TOKEN);

/** Every value that must never appear anywhere operator-visible. */
const SECRETS = [CURRENT_TOKEN, NEXT_TOKEN, THIRD_TOKEN, CURRENT_DIGEST, NEXT_DIGEST, THIRD_DIGEST].map((s) => s.toLowerCase());
const assertNoSecret = (text, where) => {
  const lower = String(text).toLowerCase();
  for (const s of SECRETS) assert.ok(!lower.includes(s), `${where} leaks a token or digest`);
};

const rotEnv = (extra = {}) => okEnv({ CANARY_SENTINEL_TOKEN: CURRENT_TOKEN, CANARY_SENTINEL_TOKEN_NEXT: NEXT_TOKEN, ...extra });

const ACL_OK_ROW = {
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
const INVENTORY_ROW = { relations: 41, functions: 12, types: 3 };

/**
 * A fake canary whose sentinel row holds exactly one digest. The read-only
 * executor answers the three fixed queries the rotation uses; the fake fetch
 * performs (or fails) the compare-and-swap against the same store.
 */
function makeCanary({
  held = CURRENT_DIGEST,
  rowCount = 1,
  inventoryAfter = null, // a different inventory row to return once the swap landed
  aclAfter = null,
  verificationOverride = null, // (digest, store) => row, to force inconsistent readings
  rotateResponse = null, // (body, store) => fake response; default performs the CAS
} = {}) {
  const store = { held, rowCount, landed: false };
  const readOnlyCalls = [];
  const readOnly = async (sql, params, context) => {
    readOnlyCalls.push({ sql, params: [...params], context });
    if (sql === sentinel.CANARY_SENTINEL_VERIFICATION_SQL) {
      assert.equal(params.length, 1);
      if (verificationOverride) return [verificationOverride(params[0], store)];
      return [{ row_count: String(store.rowCount), id_ok: true, ref_ok: true, token_ok: store.rowCount === 1 && params[0] === store.held }];
    }
    if (sql === pre.SQL_PUBLIC_INVENTORY) return [store.landed && inventoryAfter ? inventoryAfter : { ...INVENTORY_ROW }];
    if (sql === SQL_P1_ACL_CHECK) return [store.landed && aclAfter ? aclAfter : { ...ACL_OK_ROW }];
    throw new Error(`unexpected read-only SQL in rotation flow: ${sql.slice(0, 60)}`);
  };
  const { fetchImpl, calls } = makeFakeFetch(async (body) => {
    if (body.query !== PR_REQUEST_SQL) throw new Error(`unexpected SQL reached the fake endpoint: ${body.query.slice(0, 40)}`);
    if (rotateResponse) return rotateResponse(body, store);
    const [next, current] = body.parameters;
    if (store.rowCount === 1 && current === store.held) {
      store.held = next;
      store.landed = true;
      return { json: [{ id: 1 }] };
    }
    return { json: [] };
  });
  return { store, readOnly, readOnlyCalls, fetchImpl, calls };
}

const run = (canary, env = rotEnv()) => {
  const probe = createCanaryWriteProbeTransport(env, canary.fetchImpl);
  return runCanarySentinelRotation({ env, readOnly: canary.readOnly, probe });
};

const APPROVED_SQL =
  "UPDATE canary_guard.sentinel\n" +
  "SET token_sha256 = $1\n" +
  "WHERE id = 1\n" +
  "  AND project_ref = 'thqjtoxzkujnljsmkwkp'\n" +
  "  AND token_sha256 = $2\n" +
  "RETURNING id;";

// ------------------------------------------------------------ the statement

test("the rotation SQL is exactly the approved compare-and-swap, reused verbatim, pinned to the canary", () => {
  assert.equal(sentinel.PROPOSED_CANARY_SENTINEL_ROTATE_SQL, APPROVED_SQL);
  assert.equal(PR_REQUEST_SQL, sentinel.PROPOSED_CANARY_SENTINEL_ROTATE_SQL);
  assert.equal((PR_REQUEST_SQL.match(/;/g) ?? []).length, 1, "one statement (the parameterized path accepts exactly one)");
  assert.ok(PR_REQUEST_SQL.includes(guard.CANARY_PROJECT_REF));
  assert.ok(!PR_REQUEST_SQL.includes(guard.FORBIDDEN_PRODUCTION_REF) && !PR_REQUEST_SQL.includes(guard.FORBIDDEN_A7_REF));
  assert.doesNotMatch(PR_REQUEST_SQL, /a7_guard/i);
  assert.doesNotMatch(PR_REQUEST_SQL, /\b(insert|delete|drop|truncate|alter|grant|revoke|create)\b/i);
  assert.match(PR_REQUEST_SQL, /token_sha256 = \$1/);
  assert.match(PR_REQUEST_SQL, /token_sha256 = \$2/);
  assert.match(PR_REQUEST_SQL, /RETURNING id;$/, "returns the id only — never a digest");
  assert.equal(sentinel.CANARY_SENTINEL_TOKEN_NEXT_ENV, "CANARY_SENTINEL_TOKEN_NEXT");
});

test("the next-token env name passes the environment guard and is not mistaken for a Supabase credential", () => {
  assert.equal(guard.findLocalSupabaseCredentials(rotEnv()).length, 0);
  assert.deepEqual(guard.checkCanaryEnvironment(rotEnv()), { ok: true, ref: guard.CANARY_PROJECT_REF });
  assert.equal(deriveNextSentinelDigestFromEnv(rotEnv()), NEXT_DIGEST);
});

// ------------------------------------------------------------ transport surface and request shape

test("the transport surface gains exactly one rotation member taking two digests; everything else is unchanged", () => {
  const t = createCanaryWriteProbeTransport(okEnv(), makeFakeFetch(async () => ({ json: [] })).fetchImpl);
  assert.deepEqual(Object.keys(t).sort(), [
    "runManifestMigration",
    "runP1Ddl",
    "runP1Insert",
    "runP2Hardening",
    "runSentinelRotation",
    "runValidationStatement",
    "runW1",
    "runW2",
    "runW3",
  ]);
  assert.ok(Object.isFrozen(t));
  assert.equal(t.runSentinelRotation.length, 2, "runSentinelRotation takes (next digest, current digest)");
  assert.equal(t.runP1Insert.length, 1, "P1 insert still takes exactly one digest");
});

test("the rotation posts read_only:false with exactly two bound digests [next, current], no auth header, pinned endpoint", async () => {
  const canary = makeCanary();
  const t = createCanaryWriteProbeTransport(rotEnv(), canary.fetchImpl);
  const r = await t.runSentinelRotation(NEXT_DIGEST, CURRENT_DIGEST);
  assert.deepEqual(r, { authorized: true, httpStatus: 200, rowsReturned: 1, idOk: true });
  assert.equal(canary.calls.length, 1);
  const call = canary.calls[0];
  assert.equal(call.url, guard.CANARY_QUERY_ENDPOINT);
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.deepEqual(Object.keys(call.init.headers), ["Content-Type"], "Content-Type is the only header");
  assert.equal(call.body.query, PR_REQUEST_SQL);
  assert.equal(call.body.read_only, false);
  assert.deepEqual(call.body.parameters, [NEXT_DIGEST, CURRENT_DIGEST], "$1 = next digest, $2 = current digest");
  assert.deepEqual(Object.keys(call.body).sort(), ["parameters", "query", "read_only"]);
  assert.equal(canary.store.held, NEXT_DIGEST);
});

test("malformed, identical, missing or extra parameters refuse BEFORE any network use", async () => {
  const canary = makeCanary();
  const t = createCanaryWriteProbeTransport(rotEnv(), canary.fetchImpl);
  const bad = [
    [NEXT_TOKEN, CURRENT_DIGEST], // a UUID is not a digest
    [NEXT_DIGEST, CURRENT_TOKEN],
    [NEXT_DIGEST.toUpperCase(), CURRENT_DIGEST], // digests are lower-case hex
    [NEXT_DIGEST.slice(1), CURRENT_DIGEST], // 63 chars
    [`${NEXT_DIGEST}0`, CURRENT_DIGEST], // 65 chars
    [PR_REQUEST_SQL, CURRENT_DIGEST], // SQL-shaped text
    ["drop schema canary_guard cascade", CURRENT_DIGEST],
    [NEXT_DIGEST, NEXT_DIGEST], // identical: a rotation must change the digest
    [NEXT_DIGEST], // missing current
    [NEXT_DIGEST, undefined],
    [undefined, CURRENT_DIGEST],
    [NEXT_DIGEST, CURRENT_DIGEST, THIRD_DIGEST], // extra parameter
    [NEXT_DIGEST, CURRENT_DIGEST, "x"],
    [42, CURRENT_DIGEST],
    [[NEXT_DIGEST], CURRENT_DIGEST],
  ];
  for (const args of bad) {
    await assert.rejects(t.runSentinelRotation(...args), probeStops("PR_DIGESTS_INVALID"), `args=${args.length}`);
  }
  assert.equal(canary.calls.length, 0, "nothing reached the endpoint");
  assert.equal(canary.store.held, CURRENT_DIGEST);
});

test("the rotation statement is unreachable through every other member (frozen path, P9 shapes, manifest hash gate)", async () => {
  const canary = makeCanary();
  const t = createCanaryWriteProbeTransport(rotEnv(), canary.fetchImpl);
  await assert.rejects(t.runValidationStatement(PR_REQUEST_SQL, [NEXT_DIGEST, CURRENT_DIGEST], "x"), probeStops("PROBE_SQL_NOT_ALLOWLISTED"));
  await assert.rejects(t.runManifestMigration(PR_REQUEST_SQL, "0000_rotate.sql", digestOf(PR_REQUEST_SQL)), probeStops("P3_FILE_NOT_IN_MANIFEST"));
  await assert.rejects(t.runP1Insert(PR_REQUEST_SQL), probeStops("P1_DIGEST_INVALID"));
  assert.equal(canary.calls.length, 0);
  // The frozen P9 statements are untouched: none of them reference the guard schema or the rotation shape.
  for (const sql of [
    lib.P9_SQL_CREATE_WORKSPACE,
    lib.P9_SQL_CREATE_RESOURCE,
    lib.P9_SQL_CREATE_AGENT,
    lib.P9_SQL_CREATE_ASSIGNMENT,
    lib.P9_SQL_APPLY_DOCUMENT_CHANGES,
    lib.P9_SQL_REINDEX_DOCUMENT,
    lib.P9_SQL_MATCH_CHUNKS,
    lib.P9_SQL_CLEANUP_WORKSPACE,
  ]) {
    assert.doesNotMatch(sql, /canary_guard/i);
    assert.notEqual(sql, PR_REQUEST_SQL);
  }
});

// ------------------------------------------------------------ transport outcomes

test("HTTP 401/403 is a finding (authorized:false), nothing executed; the runner reports not_authorized", async () => {
  for (const status of [401, 403]) {
    const canary = makeCanary({ rotateResponse: () => ({ status, text: "denied" }) });
    const report = await run(canary);
    assert.equal(report.outcome, "not_authorized");
    assert.equal(report.httpStatus, status);
    assert.equal(canary.calls.length, 1);
    assert.equal(canary.store.held, CURRENT_DIGEST);
    assert.equal(report.checks.at(-1).ok, false);
    assertNoSecret(JSON.stringify(report), "not_authorized report");
  }
});

test("non-2xx and network failures end the run as request_failed with FIXED guidance, no body text, NO retry", async () => {
  const scenarios = [
    { name: "500", rotateResponse: () => ({ status: 500, text: `ERROR: ${NEXT_DIGEST} ${CURRENT_DIGEST} boom` }) },
    { name: "400", rotateResponse: () => ({ status: 400, text: `syntax error near ${NEXT_TOKEN}` }) },
    {
      name: "network failure after the swap landed",
      rotateResponse: (body, store) => {
        store.held = body.parameters[0];
        store.landed = true;
        throw new TypeError(`fetch failed ${NEXT_DIGEST}`);
      },
    },
    { name: "network failure before the swap landed", rotateResponse: () => { throw new TypeError("fetch failed"); } },
    { name: "unparseable body", rotateResponse: () => ({ json: null, unparseable: true }) },
    { name: "non-array body", rotateResponse: () => ({ json: { id: 1 } }) },
  ];
  for (const s of scenarios) {
    const canary = makeCanary({ rotateResponse: s.rotateResponse });
    const report = await run(canary);
    assert.equal(report.outcome, "request_failed", s.name);
    assert.equal(report.recoveryGuidance, ROTATION_RECOVERY_GUIDANCE, s.name);
    assert.equal(canary.calls.length, 1, `${s.name}: exactly one request; never retried`);
    const failed = report.checks.find((c) => c.name.startsWith("rotation request: outcome UNKNOWN"));
    assert.ok(failed && failed.ok === false, s.name);
    assert.ok(!/boom|syntax error/.test(failed.detail ?? ""), `${s.name}: response body is never surfaced`);
    const captured = report.checks.find((c) => c.name.startsWith("state captured (read-only) after failure"));
    assert.ok(captured && captured.ok === true, `${s.name}: a read-only status reading is captured`);
    assertNoSecret(JSON.stringify(report), `${s.name} report`);
  }
});

test("the interrupted-response reading distinguishes a landed swap from one that never landed", async () => {
  const landed = makeCanary({
    rotateResponse: (body, store) => {
      store.held = body.parameters[0];
      store.landed = true;
      throw new TypeError("fetch failed");
    },
  });
  const r1 = await run(landed);
  assert.equal(r1.outcome, "request_failed");
  assert.match(r1.checks.find((c) => c.name.startsWith("state captured")).detail, /reading=rotated/);

  const notLanded = makeCanary({ rotateResponse: () => { throw new TypeError("fetch failed"); } });
  const r2 = await run(notLanded);
  assert.match(r2.checks.find((c) => c.name.startsWith("state captured")).detail, /reading=not_rotated/);
  assert.match(ROTATION_RECOVERY_GUIDANCE, /Do NOT re-run the rotation blindly/);
  assert.match(ROTATION_RECOVERY_GUIDANCE, /CANARY_SENTINEL_TOKEN_NEXT/);
});

test("zero returned rows (compare-and-swap matched nothing) stops with PR_NO_ROW_UPDATED; unexpected rows stop with PR_RESULT_UNEXPECTED", async () => {
  await assert.rejects(run(makeCanary({ rotateResponse: () => ({ json: [] }) })), probeStops("PR_NO_ROW_UPDATED"));
  await assert.rejects(run(makeCanary({ rotateResponse: () => ({ json: [{ id: 1 }, { id: 1 }] }) })), probeStops("PR_RESULT_UNEXPECTED"));
  await assert.rejects(run(makeCanary({ rotateResponse: () => ({ json: [{ id: 2 }] }) })), probeStops("PR_RESULT_UNEXPECTED"));
  await assert.rejects(run(makeCanary({ rotateResponse: () => ({ json: [{ id: 1, token_sha256: "x" }] }) })), probeStops("PR_RESULT_UNEXPECTED"));
  await assert.rejects(run(makeCanary({ rotateResponse: () => ({ json: [null] }) })), probeStops("PR_RESULT_UNEXPECTED"));
});

// ------------------------------------------------------------ the runner, happy path and gates

test("happy path: gate with the current token, one swap, next accepted, current refused, inventory and ACL unchanged", async () => {
  const canary = makeCanary();
  const report = await run(canary);
  assert.equal(report.outcome, "rotated");
  assert.equal(report.httpStatus, 200);
  assert.equal(report.target, guard.CANARY_PROJECT_REF);
  assert.ok(report.checks.every((c) => c.ok), JSON.stringify(report.checks));
  assert.equal(canary.calls.length, 1, "exactly one write-capable request");
  assert.equal(canary.store.held, NEXT_DIGEST);
  // Ordering: the committed gate ran BEFORE the request, and verification with both digests ran AFTER it.
  const verifications = canary.readOnlyCalls.filter((c) => c.sql === sentinel.CANARY_SENTINEL_VERIFICATION_SQL);
  assert.equal(verifications[0].params[0], CURRENT_DIGEST, "first query: the committed gate with the current token");
  assert.equal(verifications[1].params[0], NEXT_DIGEST, "before: next token not yet accepted");
  const after = verifications.slice(2).map((c) => c.params[0]);
  assert.deepEqual(after, [NEXT_DIGEST, CURRENT_DIGEST], "after: next must pass, current must fail");
  assert.ok(canary.readOnlyCalls.some((c) => c.sql === pre.SQL_PUBLIC_INVENTORY));
  assert.ok(canary.readOnlyCalls.some((c) => c.sql === SQL_P1_ACL_CHECK));
  assert.ok(canary.readOnlyCalls.every((c) => c.sql !== PR_REQUEST_SQL), "the rotation statement never travels through the read-only executor");
  assertNoSecret(JSON.stringify(report), "rotated report");
  assert.match(report.checks.find((c) => c.name.startsWith("after (read-only): committed gate REFUSES")).name, /SENTINEL_TOKEN_MISMATCH/);
});

test("token gates refuse before any query or request: missing, malformed, exposed, identical", async () => {
  const cases = [
    [rotEnv({ CANARY_SENTINEL_TOKEN: undefined }), guardStops("SENTINEL_TOKEN_MISSING")],
    [rotEnv({ CANARY_SENTINEL_TOKEN: "not-a-uuid" }), guardStops("SENTINEL_TOKEN_MALFORMED")],
    [rotEnv({ NEXT_PUBLIC_X: `prefix ${CURRENT_TOKEN}` }), guardStops("SENTINEL_TOKEN_EXPOSED")],
    [rotEnv({ CANARY_SENTINEL_TOKEN_NEXT: undefined }), probeStops("PR_NEXT_TOKEN_MISSING")],
    [rotEnv({ CANARY_SENTINEL_TOKEN_NEXT: "" }), probeStops("PR_NEXT_TOKEN_MISSING")],
    [rotEnv({ CANARY_SENTINEL_TOKEN_NEXT: NEXT_DIGEST }), probeStops("PR_NEXT_TOKEN_MALFORMED"), "a digest is not a token"],
    [rotEnv({ NEXT_PUBLIC_Y: NEXT_TOKEN.toUpperCase() }), probeStops("PR_NEXT_TOKEN_EXPOSED")],
    [rotEnv({ CANARY_SENTINEL_TOKEN_NEXT: CURRENT_TOKEN }), probeStops("PR_TOKENS_IDENTICAL")],
    [rotEnv({ CANARY_SENTINEL_TOKEN_NEXT: CURRENT_TOKEN.toUpperCase() }), probeStops("PR_TOKENS_IDENTICAL"), "case-insensitive"],
  ];
  for (const [env, matcher, note] of cases) {
    const canary = makeCanary();
    await assert.rejects(run(canary, env), matcher, note);
    assert.equal(canary.readOnlyCalls.length, 0, `${note ?? ""} no query`);
    assert.equal(canary.calls.length, 0, `${note ?? ""} no request`);
  }
});

test("the committed gate with the current token must pass before the request (no request on mismatch or missing row)", async () => {
  const mismatch = makeCanary({ held: THIRD_DIGEST });
  await assert.rejects(run(mismatch), guardStops("SENTINEL_TOKEN_MISMATCH"));
  assert.equal(mismatch.calls.length, 0);
  const missing = makeCanary({ rowCount: 0 });
  await assert.rejects(run(missing), guardStops("SENTINEL_MISSING"));
  assert.equal(missing.calls.length, 0);
  const twoRows = makeCanary({ rowCount: 2 });
  await assert.rejects(run(twoRows), guardStops("SENTINEL_ROW_COUNT_INVALID"));
  assert.equal(twoRows.calls.length, 0);
});

test("a pre-request reading where the next token is already accepted stops with PR_STATE_CHANGED (nothing sent)", async () => {
  const canary = makeCanary({ verificationOverride: () => ({ row_count: "1", id_ok: true, ref_ok: true, token_ok: true }) });
  await assert.rejects(run(canary), probeStops("PR_STATE_CHANGED"));
  assert.equal(canary.calls.length, 0);
});

test("post-request verification: next not accepted -> PR_NEW_TOKEN_NOT_VALID; current still accepted -> PR_OLD_TOKEN_STILL_VALID", async () => {
  // The endpoint claims one row updated but the sentinel still holds the current digest.
  const notLanded = makeCanary({ rotateResponse: () => ({ json: [{ id: 1 }] }) });
  await assert.rejects(run(notLanded), probeStops("PR_NEW_TOKEN_NOT_VALID"));
  // The sentinel ends up holding a third digest.
  const wrongDigest = makeCanary({
    rotateResponse: (body, store) => {
      store.held = THIRD_DIGEST;
      store.landed = true;
      return { json: [{ id: 1 }] };
    },
  });
  await assert.rejects(run(wrongDigest), probeStops("PR_NEW_TOKEN_NOT_VALID"));
  // Both digests read as accepted after the swap (inconsistent with one row).
  const both = makeCanary({
    verificationOverride: (digest, store) => ({
      row_count: "1",
      id_ok: true,
      ref_ok: true,
      token_ok: store.landed ? true : digest === store.held,
    }),
  });
  await assert.rejects(run(both), probeStops("PR_OLD_TOKEN_STILL_VALID"));
  // The row vanished after the swap: the gate fails for a reason other than the token.
  const vanished = makeCanary({
    verificationOverride: (digest, store) =>
      store.landed && digest === CURRENT_DIGEST
        ? { row_count: "0", id_ok: null, ref_ok: null, token_ok: null }
        : { row_count: "1", id_ok: true, ref_ok: true, token_ok: digest === store.held },
  });
  await assert.rejects(run(vanished), probeStops("PR_STATE_CHANGED"));
});

test("inventory or sentinel ACL posture drift after the swap stops with PR_STATE_CHANGED", async () => {
  await assert.rejects(run(makeCanary({ inventoryAfter: { ...INVENTORY_ROW, relations: 42 } })), probeStops("PR_STATE_CHANGED"));
  await assert.rejects(run(makeCanary({ aclAfter: { ...ACL_OK_ROW, service_role_table: true } })), probeStops("PR_STATE_CHANGED"));
  await assert.rejects(run(makeCanary({ aclAfter: { ...ACL_OK_ROW, table_owner: "service_role" } })), probeStops("PR_STATE_CHANGED"));
});

test("malformed read-only results stop the run", async () => {
  const canary = makeCanary();
  const badInventory = async (sql, params, context) =>
    sql === pre.SQL_PUBLIC_INVENTORY ? [{ relations: "many" }] : canary.readOnly(sql, params, context);
  const probe = createCanaryWriteProbeTransport(rotEnv(), canary.fetchImpl);
  await assert.rejects(runCanarySentinelRotation({ env: rotEnv(), readOnly: badInventory, probe }), probeStops("PROBE_RESULT_MALFORMED"));
  assert.equal(canary.calls.length, 0);
});

// ------------------------------------------------------------ production / A7 rejection

test("production and A7 refs are refused first, everywhere: environment, transport construction, runner", async () => {
  const canary = makeCanary();
  assert.throws(() => createCanaryWriteProbeTransport(rotEnv({ X: guard.FORBIDDEN_PRODUCTION_REF }), canary.fetchImpl), guardStops("PRODUCTION_REF_BLOCKED"));
  assert.throws(() => createCanaryWriteProbeTransport(rotEnv({ X: guard.FORBIDDEN_A7_REF }), canary.fetchImpl), guardStops("A7_REF_BLOCKED"));
  const probe = createCanaryWriteProbeTransport(rotEnv(), canary.fetchImpl);
  await assert.rejects(
    runCanarySentinelRotation({ env: rotEnv({ X: guard.FORBIDDEN_PRODUCTION_REF, Y: guard.FORBIDDEN_A7_REF }), readOnly: canary.readOnly, probe }),
    guardStops("PRODUCTION_REF_BLOCKED"),
    "production outranks A7",
  );
  await assert.rejects(
    runCanarySentinelRotationStatus({ env: rotEnv({ A7_MODE: "1" }), readOnly: canary.readOnly }),
    guardStops("A7_MODE_SET"),
  );
  await assert.rejects(
    runCanarySentinelRotation({ env: rotEnv({ SUPABASE_SERVICE_ROLE_KEY: "eyJabc.def.ghi" }), readOnly: canary.readOnly, probe }),
    guardStops("LOCAL_SUPABASE_CREDENTIAL"),
  );
  assert.equal(canary.calls.length, 0);
  assert.equal(canary.readOnlyCalls.length, 0);
});

// ------------------------------------------------------------ read-only status

test("the read-only status reading covers all four cases and never constructs a write-capable request", async () => {
  const cases = [
    [makeCanary(), "not_rotated", 0],
    [makeCanary({ held: NEXT_DIGEST }), "rotated", 0],
    [makeCanary({ held: THIRD_DIGEST }), "neither", 1],
    [makeCanary({ rowCount: 0 }), "neither", 1],
    [makeCanary({ verificationOverride: () => ({ row_count: "1", id_ok: true, ref_ok: true, token_ok: true }) }), "both", 1],
  ];
  for (const [canary, reading] of cases) {
    const status = await runCanarySentinelRotationStatus({ env: rotEnv(), readOnly: canary.readOnly });
    assert.equal(status.reading, reading);
    assert.equal(status.currentVerifies, reading === "not_rotated" || reading === "both");
    assert.equal(status.nextVerifies, reading === "rotated" || reading === "both");
    assert.ok(Object.isFrozen(status));
    assert.equal(typeof status.guidance, "string");
    assert.equal(canary.calls.length, 0, "status never sends a write-capable request");
    assert.deepEqual(
      canary.readOnlyCalls.map((c) => c.sql),
      [sentinel.CANARY_SENTINEL_VERIFICATION_SQL, sentinel.CANARY_SENTINEL_VERIFICATION_SQL],
      "exactly the two fixed verification queries",
    );
    assertNoSecret(JSON.stringify(status), `status ${reading}`);
  }
  await assert.rejects(
    runCanarySentinelRotationStatus({ env: rotEnv({ CANARY_SENTINEL_TOKEN_NEXT: CURRENT_TOKEN }), readOnly: makeCanary().readOnly }),
    probeStops("PR_TOKENS_IDENTICAL"),
  );
});

// ------------------------------------------------------------ leakage

test("no token or digest reaches any error message, code, guidance or report text", async () => {
  const texts = [ROTATION_RECOVERY_GUIDANCE];
  const collect = async (p) => {
    try {
      const r = await p;
      texts.push(JSON.stringify(r));
    } catch (e) {
      texts.push(e.message, String(e.detail ?? ""), e.code ?? "");
    }
  };
  await collect(run(makeCanary()));
  await collect(run(makeCanary({ held: THIRD_DIGEST })));
  await collect(run(makeCanary({ rotateResponse: () => ({ json: [] }) })));
  await collect(run(makeCanary({ rotateResponse: () => ({ status: 500, text: `${NEXT_DIGEST} ${CURRENT_DIGEST}` }) })));
  await collect(run(makeCanary({ rotateResponse: () => ({ json: [{ id: 1 }] }) })));
  await collect(run(makeCanary({ inventoryAfter: { ...INVENTORY_ROW, types: 4 } })));
  await collect(run(makeCanary(), rotEnv({ CANARY_SENTINEL_TOKEN_NEXT: CURRENT_TOKEN })));
  await collect(run(makeCanary(), rotEnv({ NEXT_PUBLIC_Z: NEXT_TOKEN })));
  const t = createCanaryWriteProbeTransport(rotEnv(), makeFakeFetch(async () => ({ json: [] })).fetchImpl);
  await collect(t.runSentinelRotation(NEXT_TOKEN, CURRENT_DIGEST));
  await collect(t.runSentinelRotation(NEXT_DIGEST, NEXT_DIGEST));
  for (const s of await Promise.all(["not_rotated", "rotated"].map((_, i) => runCanarySentinelRotationStatus({ env: rotEnv(), readOnly: makeCanary({ held: i ? NEXT_DIGEST : CURRENT_DIGEST }).readOnly })))) {
    texts.push(JSON.stringify(s));
  }
  assert.ok(texts.length >= 12);
  for (const text of texts) assertNoSecret(text, "collected text");
});

test("every PR_ failure message is fixed text that names no value", () => {
  const codes = [
    "PR_NEXT_TOKEN_MISSING",
    "PR_NEXT_TOKEN_MALFORMED",
    "PR_NEXT_TOKEN_EXPOSED",
    "PR_TOKENS_IDENTICAL",
    "PR_DIGESTS_INVALID",
    "PR_NO_ROW_UPDATED",
    "PR_RESULT_UNEXPECTED",
    "PR_NEW_TOKEN_NOT_VALID",
    "PR_OLD_TOKEN_STILL_VALID",
    "PR_STATE_CHANGED",
  ];
  for (const code of codes) {
    const e = new CanaryProbeError(code);
    assert.match(e.message, new RegExp(`^CANARY PROBE STOPPED \\[${code}\\]: `));
    assertNoSecret(e.message, code);
  }
});

// ------------------------------------------------------------ CLI

test("the CLI requires exact, distinct phrases for rotation and for the read-only status reading", () => {
  assert.equal(cli.parseProbeCliArgs([`--confirm-rotate=${cli.CANARY_ROTATION_CONFIRMATION_PHRASE}`]), "rotate");
  assert.equal(cli.parseProbeCliArgs([`--confirm-rotation-status=${cli.CANARY_ROTATION_STATUS_CONFIRMATION_PHRASE}`]), "rotation-status");
  assert.notEqual(cli.CANARY_ROTATION_CONFIRMATION_PHRASE, cli.CANARY_ROTATION_STATUS_CONFIRMATION_PHRASE);
  assert.match(cli.CANARY_ROTATION_CONFIRMATION_PHRASE, /ROTATION/);
  assert.match(cli.CANARY_ROTATION_CONFIRMATION_PHRASE, new RegExp(`${guard.CANARY_PROJECT_REF}$`));
  assert.match(cli.CANARY_ROTATION_STATUS_CONFIRMATION_PHRASE, /READ-ONLY/);
  assert.throws(() => cli.parseProbeCliArgs(["--confirm-rotate=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(() => cli.parseProbeCliArgs(["--confirm-rotation-status=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  const others = [
    cli.CANARY_PROBE_CONFIRMATION_PHRASE,
    cli.CANARY_W3_CONFIRMATION_PHRASE,
    cli.CANARY_P1_CONFIRMATION_PHRASE,
    cli.CANARY_P2_CONFIRMATION_PHRASE,
    cli.CANARY_ROTATION_STATUS_CONFIRMATION_PHRASE,
  ];
  for (const phrase of others) {
    assert.throws(() => cli.parseProbeCliArgs([`--confirm-rotate=${phrase}`]), guardStops("CONFIRMATION_REQUIRED"), "no other phrase unlocks rotation");
  }
  for (const flag of ["--confirm=", "--confirm-w3=", "--confirm-p1=", "--confirm-p2=", "--confirm-rotation-status="]) {
    assert.throws(
      () => cli.parseProbeCliArgs([`${flag}${cli.CANARY_ROTATION_CONFIRMATION_PHRASE}`]),
      guardStops("CONFIRMATION_REQUIRED"),
      `the rotation phrase does not unlock ${flag}`,
    );
  }
  assert.throws(() => cli.parseProbeCliArgs([`--confirm-rotate=${cli.CANARY_ROTATION_CONFIRMATION_PHRASE}`, "extra"]), guardStops("INVALID_ARGS"));
});
