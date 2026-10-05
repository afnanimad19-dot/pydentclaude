// A7 sentinel-aware mutation guard — fail-closed behavior. PURE tests: the
// executor is always a mock, no network or Supabase connection is ever made,
// and no real sentinel token is used anywhere (FAKE_TOKEN below is a fixture).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { A7_PROJECT_REF, A7_SUPABASE_URL, FORBIDDEN_PRODUCTION_REF, A7GuardError, checkA7Config } =
  await import("@/lib/a7-guard");
const sentinelModule = await import("@/lib/a7-sentinel-guard");
const { authorizeA7Mutation, SENTINEL_VERIFICATION_SQL, A7SentinelGuardError } = sentinelModule;

// Fixtures — obviously fake, never the real operator token.
const FAKE_TOKEN = "11111111-2222-4333-8444-555555555555";
const OTHER_TOKEN = "99999999-8888-4777-a666-555555555544";
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

const validEnv = () => ({
  A7_MODE: "1",
  A7_EXPECTED_REF: A7_PROJECT_REF,
  NEXT_PUBLIC_SUPABASE_URL: A7_SUPABASE_URL,
  A7_SENTINEL_TOKEN: FAKE_TOKEN,
});

// Mock "database": emulates the real sentinel comparison. The digest arrives
// as the single BOUND PARAMETER (never inside the SQL text) and is compared
// against the sha256 of the token stored in the fake DB row — exactly what the
// fixed SQL's built-in sha256() comparison does server-side.
const makeDb = ({ rowCount = 1, id = 1, projectRef = A7_PROJECT_REF, dbToken = FAKE_TOKEN } = {}) => {
  const calls = [];
  const exec = async (sql, parameters) => {
    calls.push({ sql, parameters });
    assert.equal(sql, SENTINEL_VERIFICATION_SQL, "only the fixed verification SQL is ever sent");
    assert.ok(Array.isArray(parameters) && parameters.length === 1, "exactly one bound parameter");
    const digest = parameters[0];
    assert.match(digest, /^[0-9a-f]{64}$/, "the bound parameter is a sha256 hex digest");
    if (rowCount === 0) return [{ row_count: 0, id_ok: null, ref_ok: null, token_ok: null }];
    return [{
      row_count: rowCount,
      id_ok: id === 1,
      ref_ok: projectRef === A7_PROJECT_REF,
      token_ok: digest === sha256(dbToken.toLowerCase()),
    }];
  };
  exec.calls = calls;
  return exec;
};

const refusal = async (env, exec, Err, code) => {
  await assert.rejects(authorizeA7Mutation(exec, env), (e) => e instanceof Err && e.code === code, code);
};

test("valid identity + valid sentinel => mutation eligible", async () => {
  const db = makeDb();
  const auth = await authorizeA7Mutation(db, validEnv());
  assert.deepEqual(auth, { eligible: true, ref: A7_PROJECT_REF, sentinel: { id: 1, projectRef: A7_PROJECT_REF } });
  assert.equal(db.calls.length, 1);
  // The authorization result never carries the token (or anything derived from it).
  const json = JSON.stringify(auth);
  assert.ok(!json.includes(FAKE_TOKEN) && !json.includes(sha256(FAKE_TOKEN.toLowerCase())));
});

test("missing A7_SENTINEL_TOKEN => refuse, sentinel never queried", async () => {
  const env = validEnv();
  delete env.A7_SENTINEL_TOKEN;
  const db = makeDb();
  await refusal(env, db, A7SentinelGuardError, "SENTINEL_TOKEN_MISSING");
  await refusal({ ...validEnv(), A7_SENTINEL_TOKEN: "" }, db, A7SentinelGuardError, "SENTINEL_TOKEN_MISSING");
  assert.equal(db.calls.length, 0);
});

test("malformed A7_SENTINEL_TOKEN => refuse without query", async () => {
  const db = makeDb();
  for (const bad of ["not-a-uuid", "'; drop table a7_guard.sentinel; --", FAKE_TOKEN + " ", "11111111222243338444555555555555"]) {
    await refusal({ ...validEnv(), A7_SENTINEL_TOKEN: bad }, db, A7SentinelGuardError, "SENTINEL_TOKEN_MALFORMED");
  }
  assert.equal(db.calls.length, 0);
});

test("missing sentinel (schema/table absent => query throws) => refuse", async () => {
  const exec = async () => { throw new Error('relation "a7_guard.sentinel" does not exist'); };
  await refusal(validEnv(), exec, A7SentinelGuardError, "SENTINEL_QUERY_FAILED");
});

test("zero sentinel rows => refuse", async () => {
  await refusal(validEnv(), makeDb({ rowCount: 0 }), A7SentinelGuardError, "SENTINEL_MISSING");
});

test("multiple sentinel rows => refuse", async () => {
  await refusal(validEnv(), makeDb({ rowCount: 2 }), A7SentinelGuardError, "SENTINEL_ROW_COUNT_INVALID");
});

test("wrong id => refuse", async () => {
  await refusal(validEnv(), makeDb({ id: 2 }), A7SentinelGuardError, "SENTINEL_ID_MISMATCH");
});

test("wrong project_ref => refuse", async () => {
  await refusal(validEnv(), makeDb({ projectRef: "abcdefghij0123456789" }), A7SentinelGuardError, "SENTINEL_REF_MISMATCH");
});

test("wrong token => refuse", async () => {
  await refusal(validEnv(), makeDb({ dbToken: OTHER_TOKEN }), A7SentinelGuardError, "SENTINEL_TOKEN_MISMATCH");
});

test("query failure (network) and malformed results => refuse", async () => {
  await refusal(validEnv(), async () => { throw new Error("ECONNRESET"); }, A7SentinelGuardError, "SENTINEL_QUERY_FAILED");
  for (const weird of [[], [{}, {}], "nonsense", null, [{ row_count: "x" }]]) {
    await refusal(validEnv(), async () => weird, A7SentinelGuardError, "SENTINEL_RESULT_MALFORMED");
  }
});

test("production target => refuse BEFORE any sentinel access", async () => {
  const db = makeDb();
  const env = { ...validEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` };
  await refusal(env, db, A7GuardError, "PRODUCTION_TARGET_BLOCKED");
  assert.equal(db.calls.length, 0, "sentinel must never be queried for a production target");
});

test("production ref embedded in any configuration => refuse before query", async () => {
  const db = makeDb();
  for (const key of ["DATABASE_URL", "SUPABASE_DB_URL", "SOME_VAR"]) {
    await refusal({ ...validEnv(), [key]: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` }, db, A7GuardError, "PRODUCTION_TARGET_BLOCKED");
  }
  assert.equal(db.calls.length, 0);
});

test("identity guard failure (A7_MODE unset / wrong ref) => refuse before query", async () => {
  const db = makeDb();
  const noMode = validEnv();
  delete noMode.A7_MODE;
  await refusal(noMode, db, A7GuardError, "A7_MODE_MISSING");
  await refusal({ ...validEnv(), A7_EXPECTED_REF: "abcdefghij0123456789" }, db, A7GuardError, "EXPECTED_REF_MISMATCH");
  assert.equal(db.calls.length, 0);
});

test("token leaked into a NEXT_PUBLIC_* variable => refuse (client-bundle exposure)", async () => {
  const db = makeDb();
  await refusal({ ...validEnv(), NEXT_PUBLIC_DEBUG_BLOB: `x ${FAKE_TOKEN} y` }, db, A7SentinelGuardError, "SENTINEL_TOKEN_EXPOSED");
  assert.equal(db.calls.length, 0);
});

test("neither token ever appears in SQL text, bound parameters, thrown errors, or results", async () => {
  // SQL hygiene: the verification SQL is a fixed constant with no secrets, no
  // digests, and no MD5 anywhere in the design.
  assert.ok(!SENTINEL_VERIFICATION_SQL.includes(FAKE_TOKEN) && !SENTINEL_VERIFICATION_SQL.includes(OTHER_TOKEN));
  assert.doesNotMatch(SENTINEL_VERIFICATION_SQL, /[0-9a-f]{32,}/, "no embedded digest in SQL text");
  assert.doesNotMatch(SENTINEL_VERIFICATION_SQL, /md5/i, "no MD5 in the comparison design");
  assert.match(SENTINEL_VERIFICATION_SQL, /sha256\(/, "comparison uses built-in sha256 in-database");
  assert.match(SENTINEL_VERIFICATION_SQL, /\$1/, "digest arrives as a bound parameter");
  // Error hygiene: run every refusal path and scan the thrown messages.
  const failures = [
    [validEnv(), makeDb({ dbToken: OTHER_TOKEN })],
    [{ ...validEnv(), A7_SENTINEL_TOKEN: undefined }, makeDb()],
    [validEnv(), async () => { throw new Error(`boom ${FAKE_TOKEN}`); }], // hostile cause is swallowed
    [validEnv(), makeDb({ rowCount: 0 })],
    [{ ...validEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` }, makeDb()],
  ];
  const inspected = [];
  for (const [env, exec] of failures) {
    if (exec.calls) inspected.push(exec);
    try {
      await authorizeA7Mutation(exec, env);
      assert.fail("expected refusal");
    } catch (e) {
      const text = `${e.name} ${e.code ?? ""} ${e.message} ${e.stack ?? ""}`;
      assert.ok(!text.includes(FAKE_TOKEN), "operator token must not appear in errors");
      assert.ok(!text.includes(OTHER_TOKEN), "db token must not appear in errors");
    }
  }
  // Parameter hygiene: everything sent to the executor is digest-only.
  for (const db of inspected) {
    for (const { sql, parameters } of db.calls) {
      assert.ok(!sql.includes(FAKE_TOKEN) && !sql.includes(OTHER_TOKEN));
      for (const p of parameters) {
        assert.ok(p !== FAKE_TOKEN && p !== OTHER_TOKEN && !p.includes(FAKE_TOKEN));
        assert.match(p, /^[0-9a-f]{64}$/);
      }
    }
  }
});

test("the module cannot itself mutate: advisory-only export surface, fixed read-only SQL", async () => {
  // Export surface holds no mutation capability: no function accepts or runs
  // caller-supplied SQL, and the only SQL the module ever emits is the fixed
  // single read-only SELECT (asserted per-call inside the mock executor).
  assert.deepEqual(Object.keys(sentinelModule).sort(), [
    "A7SentinelGuardError",
    "SENTINEL_VERIFICATION_SQL",
    "authorizeA7Mutation",
  ]);
  assert.match(SENTINEL_VERIFICATION_SQL.trimStart(), /^select /);
  assert.doesNotMatch(SENTINEL_VERIFICATION_SQL, /insert|update|delete|create|alter|drop|grant|revoke|truncate/i);
  // Authorization is advisory: the result is plain safe metadata, not an
  // executor or capability object the caller could "use" to mutate.
  const auth = await authorizeA7Mutation(makeDb(), validEnv());
  assert.deepEqual(Object.keys(auth).sort(), ["eligible", "ref", "sentinel"]);
  for (const v of [auth.eligible, auth.ref, auth.sentinel.id, auth.sentinel.projectRef]) {
    assert.ok(["string", "number", "boolean"].includes(typeof v));
  }
});

test("normal non-A7 production runtime remains unaffected", async () => {
  // Without A7_MODE, the identity guard refuses mutations (mutations are an A7
  // concept), but the application-runtime guards stay no-ops exactly as before.
  const db = makeDb();
  await refusal({ A7_SENTINEL_TOKEN: FAKE_TOKEN }, db, A7GuardError, "A7_MODE_MISSING");
  assert.equal(db.calls.length, 0);
  const r = checkA7Config({});
  assert.equal(r.ok, false); // unchanged pre-existing behavior
  // The sentinel module must not be imported by any runtime entry point, so it
  // (and A7_SENTINEL_TOKEN) can never reach the client bundle or app runtime.
  const root = path.resolve(import.meta.dirname, "..");
  for (const f of ["src/lib/supabase.ts", "src/lib/supabase-admin.ts", "src/instrumentation.ts", "next.config.ts"]) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    assert.ok(!src.includes("a7-sentinel-guard"), `${f} must not import the sentinel guard`);
    assert.ok(!src.includes("A7_SENTINEL_TOKEN"), `${f} must not reference the token var`);
  }
  // And the token env var is never NEXT_PUBLIC-prefixed anywhere in src/.
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        assert.ok(!fs.readFileSync(p, "utf8").includes("NEXT_PUBLIC_A7_SENTINEL"), p);
      }
    }
  };
  scan(path.join(root, "src"));
});
