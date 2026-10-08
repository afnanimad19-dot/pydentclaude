// Canary sentinel design + authorization — PURE OFFLINE tests.
// Covers: authorization failures (every sentinel refusal code), refusal
// BEFORE any query on guard/token problems, digest-only transmission, and
// that the setup SQL is a proposal no code path executes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { okEnv, FAKE_SENTINEL_TOKEN } from "./canary-fixtures.mjs";

const s = await import("../scripts/canary-sentinel.ts");
const { CanaryError, CANARY_PROJECT_REF, FORBIDDEN_A7_REF, FORBIDDEN_PRODUCTION_REF } = await import("../scripts/canary-guard.ts");
const root = path.resolve(import.meta.dirname, "..");

const envWithToken = (extra = {}) => okEnv({ CANARY_SENTINEL_TOKEN: FAKE_SENTINEL_TOKEN, ...extra });
const digest = createHash("sha256").update(FAKE_SENTINEL_TOKEN).digest("hex");
const goodRow = { row_count: 1, id_ok: true, ref_ok: true, token_ok: true };

function recorder(result) {
  const calls = [];
  const exec = async (sql, params, context) => {
    calls.push({ sql, params, context });
    if (result instanceof Error) throw result;
    return typeof result === "function" ? result(sql, params) : result;
  };
  return { exec, calls };
}

const code = (c) => (e) => e instanceof CanaryError && e.code === c;

test("a valid sentinel authorizes with safe metadata only", async () => {
  const { exec, calls } = recorder([goodRow]);
  const auth = await s.authorizeCanaryMutation(exec, envWithToken());
  assert.deepEqual(auth, { eligible: true, ref: CANARY_PROJECT_REF, sentinel: { id: 1, projectRef: CANARY_PROJECT_REF } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, s.CANARY_SENTINEL_VERIFICATION_SQL);
  assert.deepEqual(calls[0].params, [digest], "only the digest travels, as a bound parameter");
  assert.ok(!calls[0].sql.includes(FAKE_SENTINEL_TOKEN) && !calls[0].sql.includes(digest));
  assert.ok(!JSON.stringify(auth).includes(FAKE_SENTINEL_TOKEN));
});

test("guard and token problems refuse BEFORE any query", async () => {
  for (const [env, c] of [
    [envWithToken({ X: FORBIDDEN_PRODUCTION_REF }), "PRODUCTION_REF_BLOCKED"],
    [envWithToken({ X: FORBIDDEN_A7_REF }), "A7_REF_BLOCKED"],
    [okEnv(), "SENTINEL_TOKEN_MISSING"],
    [okEnv({ CANARY_SENTINEL_TOKEN: "" }), "SENTINEL_TOKEN_MISSING"],
    [okEnv({ CANARY_SENTINEL_TOKEN: "not-a-uuid" }), "SENTINEL_TOKEN_MALFORMED"],
    [envWithToken({ NEXT_PUBLIC_LEAK: `x${FAKE_SENTINEL_TOKEN.toUpperCase()}` }), "SENTINEL_TOKEN_EXPOSED"],
  ]) {
    const { exec, calls } = recorder([goodRow]);
    await assert.rejects(s.authorizeCanaryMutation(exec, env), code(c));
    assert.equal(calls.length, 0, c);
  }
});

test("every sentinel mismatch refuses with its fixed code", async () => {
  for (const [result, c] of [
    [new Error("relation canary_guard.sentinel does not exist"), "SENTINEL_QUERY_FAILED"],
    [[], "SENTINEL_RESULT_MALFORMED"],
    [[goodRow, goodRow], "SENTINEL_RESULT_MALFORMED"],
    [[{ ...goodRow, row_count: "abc" }], "SENTINEL_RESULT_MALFORMED"],
    [[{ ...goodRow, row_count: 0 }], "SENTINEL_MISSING"],
    [[{ ...goodRow, row_count: "2" }], "SENTINEL_ROW_COUNT_INVALID"],
    [[{ ...goodRow, id_ok: false }], "SENTINEL_ID_MISMATCH"],
    [[{ ...goodRow, ref_ok: null }], "SENTINEL_REF_MISMATCH"],
    [[{ ...goodRow, token_ok: false }], "SENTINEL_TOKEN_MISMATCH"],
  ]) {
    const { exec } = recorder(result);
    await assert.rejects(s.authorizeCanaryMutation(exec, envWithToken()), (e) => {
      assert.equal(e.code, c);
      assert.ok(!e.message.includes(FAKE_SENTINEL_TOKEN) && !e.message.includes(digest));
      return true;
    });
  }
});

test("sentinel is pinned to the canary and separate from the A7 sentinel schema", () => {
  for (const sql of [s.PROPOSED_CANARY_SENTINEL_DDL, s.PROPOSED_CANARY_SENTINEL_INSERT_SQL, s.CANARY_SENTINEL_VERIFICATION_SQL]) {
    assert.ok(sql.includes(CANARY_PROJECT_REF));
    assert.ok(!/a7_guard/.test(sql));
    assert.ok(!sql.includes(FORBIDDEN_A7_REF) && !sql.includes(FORBIDDEN_PRODUCTION_REF));
  }
  assert.match(s.PROPOSED_CANARY_SENTINEL_DDL, /^begin;[\s\S]*commit;$/);
  assert.match(s.PROPOSED_CANARY_SENTINEL_DDL, /check \(id = 1\)/);
  assert.match(s.PROPOSED_CANARY_SENTINEL_DDL, /token_sha256 text not null check/);
  assert.doesNotMatch(s.PROPOSED_CANARY_SENTINEL_DDL, /\btoken text\b/, "the raw token is never stored");
  assert.equal((s.PROPOSED_CANARY_SENTINEL_INSERT_SQL.match(/;/g) ?? []).length, 0, "parameterized insert is one statement");
});

test("no canary module executes the sentinel setup SQL", () => {
  const scripts = fs.readdirSync(path.join(root, "scripts")).filter((f) => f.startsWith("canary-"));
  for (const f of scripts) {
    const src = fs.readFileSync(path.join(root, "scripts", f), "utf8");
    assert.ok(
      !/executeReadOnlyQuery\(\s*PROPOSED_/.test(src) && !/\(PROPOSED_[A-Z_]+,/.test(src),
      `${f} must not pass a PROPOSED_* statement to an executor`,
    );
  }
});
