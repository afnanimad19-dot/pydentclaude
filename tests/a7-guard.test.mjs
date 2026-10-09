// A7 safety guard — fail-closed behavior. These tests are PURE: the guard
// module has zero imports and performs no I/O, so every refusal below is
// demonstrated without connecting to, reading from, or modifying any database.
// All tests pass explicit env objects; process.env is never mutated.
import { test } from "node:test";
import assert from "node:assert/strict";

const {
  A7_PROJECT_REF,
  A7_SUPABASE_URL,
  FORBIDDEN_PRODUCTION_REF,
  A7GuardError,
  extractSupabaseRef,
  findProductionTargets,
  checkA7Config,
  assertA7Safe,
  enforceA7StartupGuard,
  a7AssertResolvedSupabaseUrl,
  isA7ModeConfigured,
} = await import("@/lib/a7-guard");

const OTHER_REF = "abcdefghij0123456789"; // valid shape, wrong project

const validEnv = () => ({
  A7_MODE: "1",
  A7_EXPECTED_REF: A7_PROJECT_REF,
  NEXT_PUBLIC_SUPABASE_URL: A7_SUPABASE_URL,
});

const expectFail = (env, code, label) => {
  const r = checkA7Config(env);
  assert.equal(r.ok, false, label ?? code);
  assert.equal(r.code, code, `${label ?? ""} -> ${r.ok ? "ok" : r.code}: ${r.ok ? "" : r.reason}`);
  assert.throws(() => assertA7Safe(env), (e) => e instanceof A7GuardError && e.code === code);
};

test("pinned constants match the approved A7 target and forbidden production ref", () => {
  assert.equal(A7_PROJECT_REF, "etbuylimyelwoxxowtbx");
  assert.equal(A7_SUPABASE_URL, "https://etbuylimyelwoxxowtbx.supabase.co");
  assert.equal(FORBIDDEN_PRODUCTION_REF, "mzqynjywncbvqfikbzgm");
  assert.notEqual(A7_PROJECT_REF, FORBIDDEN_PRODUCTION_REF);
});

test("valid A7 configuration passes", () => {
  const r = checkA7Config(validEnv());
  assert.deepEqual(r, { ok: true, ref: A7_PROJECT_REF, url: A7_SUPABASE_URL });
  assert.deepEqual(assertA7Safe(validEnv()), { ref: A7_PROJECT_REF, url: A7_SUPABASE_URL });
  // Extra unrelated vars don't break a valid config.
  const r2 = checkA7Config({ ...validEnv(), HOME: "/home/user", NODE_ENV: "test" });
  assert.equal(r2.ok, true);
});

test("missing A7_MODE fails", () => {
  const env = validEnv();
  delete env.A7_MODE;
  expectFail(env, "A7_MODE_MISSING");
  expectFail({ ...validEnv(), A7_MODE: "" }, "A7_MODE_MISSING", "empty A7_MODE");
});

test('A7_MODE not exactly "1" fails', () => {
  for (const bad of ["0", "true", "yes", "01", " 1", "1 ", "2", "on"]) {
    expectFail({ ...validEnv(), A7_MODE: bad }, "A7_MODE_INVALID", `A7_MODE=${JSON.stringify(bad)}`);
  }
});

test("missing expected ref fails", () => {
  const env = validEnv();
  delete env.A7_EXPECTED_REF;
  expectFail(env, "EXPECTED_REF_MISSING");
  expectFail({ ...validEnv(), A7_EXPECTED_REF: "" }, "EXPECTED_REF_MISSING", "empty A7_EXPECTED_REF");
});

test("expected ref that is not the A7 project fails", () => {
  expectFail({ ...validEnv(), A7_EXPECTED_REF: OTHER_REF }, "EXPECTED_REF_MISMATCH");
});

test("missing NEXT_PUBLIC_SUPABASE_URL fails — the guard aborts instead of falling back", () => {
  const env = validEnv();
  delete env.NEXT_PUBLIC_SUPABASE_URL;
  expectFail(env, "SUPABASE_URL_MISSING");
  expectFail({ ...validEnv(), NEXT_PUBLIC_SUPABASE_URL: "" }, "SUPABASE_URL_MISSING", "empty URL");
});

test("malformed URL fails", () => {
  for (const bad of [
    `http://${A7_PROJECT_REF}.supabase.co`, // not https
    `https://${A7_PROJECT_REF}.supabase.co/`, // trailing slash
    `https://${A7_PROJECT_REF}.supabase.co/rest/v1`, // path
    `https://${A7_PROJECT_REF}.supabase.co:443`, // explicit port
    `https://user:pass@${A7_PROJECT_REF}.supabase.co`, // credentials
    `https://${A7_PROJECT_REF}.supabase.co?x=1`, // query
    `https://${A7_PROJECT_REF}.supabase.co.evil.com`, // suffix attack
    `https://evil.com/${A7_PROJECT_REF}.supabase.co`, // ref in path
    `https://${A7_PROJECT_REF.toUpperCase()}.supabase.co`, // uppercase
    ` https://${A7_PROJECT_REF}.supabase.co`, // whitespace
    `${A7_PROJECT_REF}.supabase.co`, // no scheme
    "https://short.supabase.co", // ref wrong length
    "not a url",
  ]) {
    expectFail({ ...validEnv(), NEXT_PUBLIC_SUPABASE_URL: bad }, "SUPABASE_URL_MALFORMED", JSON.stringify(bad));
  }
});

test("wrong (non-A7, non-production) ref in the URL fails", () => {
  const env = { ...validEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${OTHER_REF}.supabase.co` };
  expectFail(env, "REF_MISMATCH");
});

test("FORBIDDEN PRODUCTION REF mzqynjywncbvqfikbzgm is refused — pure string check, no connection is ever made", () => {
  // As the URL target:
  expectFail(
    { ...validEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` },
    "PRODUCTION_TARGET_BLOCKED",
    "production URL",
  );
  // As the expected ref:
  expectFail({ ...validEnv(), A7_EXPECTED_REF: FORBIDDEN_PRODUCTION_REF }, "PRODUCTION_TARGET_BLOCKED", "production expected ref");
  // In any database/management target variable:
  for (const key of ["DATABASE_URL", "SUPABASE_DB_URL", "SUPABASE_ACCESS_TOKEN_PROJECT", "SOME_UNANTICIPATED_VAR"]) {
    expectFail(
      { ...validEnv(), [key]: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` },
      "PRODUCTION_TARGET_BLOCKED",
      key,
    );
  }
});

test("production blocking takes priority over every other check", () => {
  // Even with A7_MODE missing AND expected ref missing AND URL malformed,
  // the verdict must be PRODUCTION_TARGET_BLOCKED, nothing else.
  const r = checkA7Config({ NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co/` });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PRODUCTION_TARGET_BLOCKED");
});

test("production refusal names the offending env var KEY but never leaks its value", () => {
  const secretValue = `postgresql://postgres:supersecretpw@db.${FORBIDDEN_PRODUCTION_REF}.supabase.co:5432/postgres`;
  const r = checkA7Config({ ...validEnv(), DATABASE_URL: secretValue });
  assert.equal(r.ok, false);
  assert.equal(r.code, "PRODUCTION_TARGET_BLOCKED");
  assert.ok(r.reason.includes("DATABASE_URL"), "names the key");
  assert.ok(!r.reason.includes("supersecretpw"), "never prints the value");
  assert.deepEqual(findProductionTargets({ DATABASE_URL: secretValue, OK: "x" }), ["DATABASE_URL"]);
});

test("no silent fallback to production: the resolved-URL tripwire refuses the hardcoded fallback in A7 mode", () => {
  const fallbackUrl = `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co`;
  // A7 mode configured (any value, even "0") -> the production fallback throws.
  for (const mode of ["1", "0", "junk"]) {
    assert.throws(
      () => a7AssertResolvedSupabaseUrl(fallbackUrl, { ...validEnv(), A7_MODE: mode }),
      (e) => e instanceof A7GuardError && e.code === "PRODUCTION_TARGET_BLOCKED",
      `A7_MODE=${mode}`,
    );
  }
  // A7 mode + a non-production, non-A7 URL also throws (fail closed).
  assert.throws(
    () => a7AssertResolvedSupabaseUrl(`https://${OTHER_REF}.supabase.co`, validEnv()),
    (e) => e instanceof A7GuardError && e.code === "SUPABASE_URL_MISMATCH",
  );
  // A7 mode + the exact A7 URL, but an otherwise broken A7 config -> still refuses.
  assert.throws(
    () => a7AssertResolvedSupabaseUrl(A7_SUPABASE_URL, { A7_MODE: "1" }),
    (e) => e instanceof A7GuardError,
  );
  // A7 mode + fully valid config -> passes through the A7 URL.
  assert.equal(a7AssertResolvedSupabaseUrl(A7_SUPABASE_URL, validEnv()), A7_SUPABASE_URL);
  // A7 mode absent -> legacy behavior untouched (this stage does not remove fallbacks).
  assert.equal(isA7ModeConfigured({}), false);
  assert.equal(a7AssertResolvedSupabaseUrl(fallbackUrl, {}), fallbackUrl);
});

test("startup guard: no-op without A7_MODE, enforced (fail closed) when A7_MODE is set at all", () => {
  assert.deepEqual(enforceA7StartupGuard({}), { active: false });
  assert.deepEqual(enforceA7StartupGuard(validEnv()), { active: true, ref: A7_PROJECT_REF });
  // A7_MODE set to anything but "1" with an otherwise perfect env still aborts.
  assert.throws(
    () => enforceA7StartupGuard({ ...validEnv(), A7_MODE: "0" }),
    (e) => e instanceof A7GuardError && e.code === "A7_MODE_INVALID",
  );
  // A7_MODE=1 but nothing else set -> abort, never fall through.
  assert.throws(
    () => enforceA7StartupGuard({ A7_MODE: "1" }),
    (e) => e instanceof A7GuardError && e.code === "EXPECTED_REF_MISSING",
  );
});

test("extractSupabaseRef accepts only the exact project-URL shape", () => {
  assert.equal(extractSupabaseRef(A7_SUPABASE_URL), A7_PROJECT_REF);
  assert.equal(extractSupabaseRef(`https://${OTHER_REF}.supabase.co`), OTHER_REF);
  for (const bad of [undefined, null, 42, "", "https://supabase.co", `https://${A7_PROJECT_REF}.supabase.com`]) {
    assert.equal(extractSupabaseRef(bad), null, String(bad));
  }
});

test("server startup hook (src/instrumentation.ts) refuses to register with a broken A7 env", async () => {
  // register() reads process.env; point it at a broken A7 config, restore after.
  const saved = {};
  const keys = ["A7_MODE", "A7_EXPECTED_REF", "NEXT_PUBLIC_SUPABASE_URL"];
  for (const k of keys) saved[k] = process.env[k];
  try {
    process.env.A7_MODE = "1";
    delete process.env.A7_EXPECTED_REF;
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    const { register } = await import("@/instrumentation");
    assert.throws(() => register(), (e) => e instanceof A7GuardError && e.code === "EXPECTED_REF_MISSING");
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
});
