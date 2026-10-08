// Canary read-only preflight — PURE OFFLINE tests. The transport under test is
// the real createCanaryReadOnlyTransport wired to a fake fetch that answers
// from an in-memory catalog, so read_only:true and the pinned URL are proven
// on every preflight request.
import { test } from "node:test";
import assert from "node:assert/strict";
import { okEnv, makeFakeFetch, makeCanaryCatalog, HARDENED_ACL, GOOD_CONTRACT } from "./canary-fixtures.mjs";

const pre = await import("../scripts/canary-preflight-lib.ts");
const plan = await import("../scripts/canary-plan-lib.ts");
const sentinel = await import("../scripts/canary-sentinel.ts");
const manifest = await import("../scripts/canary-manifest-check.ts");
const { createCanaryReadOnlyTransport } = await import("../scripts/canary-transport.ts");
const { CanaryError, CANARY_QUERY_ENDPOINT, FORBIDDEN_PRODUCTION_REF } = await import("../scripts/canary-guard.ts");
const { parsePreflightCliArgs } = await import("../scripts/canary-preflight.ts");
const lib = { pre, plan, sentinel, manifest };

const ALL_STEPS = [...manifest.CANARY_STEP_ORDER];

async function run(overrides = {}, env = okEnv()) {
  const { fetchImpl, calls } = makeFakeFetch(makeCanaryCatalog(lib, overrides));
  const t = createCanaryReadOnlyTransport(env, fetchImpl);
  const report = await pre.runCanaryPreflight({ env, executeReadOnlyQuery: t.executeReadOnlyQuery });
  return { report, calls };
}
const check = (report, prefix) => report.checks.find((c) => c.name.startsWith(prefix));

test("blank canary (today's observed state): passes, but write steps stay blocked", async () => {
  const { report, calls } = await run();
  assert.equal(report.passed, true);
  assert.equal(report.readyForWrites, false);
  assert.equal(report.state, "blank");
  assert.equal(report.completedThrough, null);
  assert.equal(check(report, "canary sentinel present").ok, false);
  const acl = check(report, "default privileges A7-equivalent");
  assert.equal(acl.ok, false, "permissive defaults are never accepted as A7-equivalent");
  assert.match(acl.detail, /NOT A7-equivalent/);
  assert.match(acl.detail, /privilege hardening/);
  // Every request: pinned endpoint + read_only:true.
  assert.ok(calls.length > 0);
  for (const c of calls) {
    assert.equal(c.url, CANARY_QUERY_ENDPOINT);
    assert.equal(c.body.read_only, true);
  }
  // Blank: no marker or residue queries were needed.
  assert.ok(!calls.some((c) => c.body.query === pre.SQL_RESIDUE));
});

test("the first query is the session check, and a writable session stops everything", async () => {
  for (const o of [{ role: "postgres" }, { txReadOnly: "off" }, { defaultReadOnly: "off" }]) {
    const { fetchImpl, calls } = makeFakeFetch(makeCanaryCatalog(lib, o));
    const t = createCanaryReadOnlyTransport(okEnv(), fetchImpl);
    await assert.rejects(
      pre.runCanaryPreflight({ env: okEnv(), executeReadOnlyQuery: t.executeReadOnlyQuery }),
      (e) => e instanceof CanaryError && e.code === "PREFLIGHT_NOT_READ_ONLY",
    );
    assert.equal(calls.length, 1, "no query after the failed session check");
    assert.equal(calls[0].body.query, pre.SQL_SESSION);
  }
});

test("a forbidden ref in the env refuses before any query", async () => {
  const calls = [];
  const exec = async (...a) => (calls.push(a), []);
  await assert.rejects(
    pre.runCanaryPreflight({ env: okEnv({ X: FORBIDDEN_PRODUCTION_REF }), executeReadOnlyQuery: exec }),
    (e) => e.code === "PRODUCTION_REF_BLOCKED",
  );
  assert.equal(calls.length, 0);
});

test("a7_guard present means this is not the canary: required failure", async () => {
  const { report } = await run({ a7GuardAbsent: false });
  assert.equal(report.passed, false);
  assert.equal(check(report, "a7_guard schema absent").ok, false);
});

test("migration-history rows of unknown provenance fail the preflight", async () => {
  const { report } = await run({ historyRows: 3 });
  assert.equal(report.passed, false);
  assert.match(check(report, "migration history").detail, /rows=3/);
});

test("absent history table and missing pgcrypto are handled", async () => {
  const a = await run({ historyPresent: false });
  assert.equal(a.report.passed, true);
  assert.ok(!a.calls.some((c) => c.body.query === pre.SQL_HISTORY_COUNT));
  const b = await run({ pgcrypto: { available: false, installed: false } });
  assert.equal(b.report.passed, false);
});

test("partial state: markers stop at the first incomplete step; residue checked once workspaces exist", async () => {
  const { report, calls } = await run({ relations: 300, functions: 20, completedSteps: ["baseline-0001-0064", "apply-0065"] });
  assert.equal(report.state, "partial");
  assert.equal(report.completedThrough, "apply-0065");
  const markerQueries = calls.filter((c) => Object.values(plan.STEP_MARKER_SQL).includes(c.body.query));
  assert.equal(markerQueries.length, 3, "baseline, 0065, then stop at 0067");
  const residueCall = calls.find((c) => c.body.query === pre.SQL_RESIDUE);
  assert.deepEqual(residueCall.body.parameters, ["CANARY-2B-VALIDATION %", "A7-2B-VALIDATION %"]);
});

test("validation residue is a required failure (detected, never cleaned)", async () => {
  const { report, calls } = await run({ relations: 300, completedSteps: ["baseline-0001-0064"], residue: 2 });
  assert.equal(report.passed, false);
  assert.match(check(report, "no validation residue").detail, /residue=2/);
  assert.ok(calls.every((c) => /^\s*select\b/i.test(c.body.query)), "only SELECTs are ever sent");
});

test("migrated + hardened + sentinel: ready for writes; post-migration contract enforced", async () => {
  const ok = await run({
    relations: 400,
    completedSteps: ALL_STEPS,
    contract: GOOD_CONTRACT,
    defaultAcl: HARDENED_ACL,
    sentinel: { schema_present: true, table_present: true },
  });
  assert.equal(ok.report.state, "migrated");
  assert.equal(ok.report.passed, true, JSON.stringify(ok.report.checks.filter((c) => !c.ok)));
  assert.equal(ok.report.readyForWrites, true);

  const leaky = GOOD_CONTRACT.map((r) => (r.table_name === "knowledge_chunks" ? { ...r, anon_any: true } : r));
  const bad = await run({ relations: 400, completedSteps: ALL_STEPS, contract: leaky, defaultAcl: HARDENED_ACL });
  assert.equal(bad.report.passed, false);
  assert.equal(check(bad.report, "knowledge_chunks: anon/authenticated").ok, false);

  const missing = await run({ relations: 400, completedSteps: ALL_STEPS, contract: GOOD_CONTRACT.slice(1) });
  assert.equal(missing.report.passed, false);
});

test("transport failure mid-preflight propagates (fail closed, no partial PASS)", async () => {
  const catalog = makeCanaryCatalog(lib);
  const { fetchImpl } = makeFakeFetch((body) => (body.query === pre.SQL_PGCRYPTO ? { status: 500, text: "boom" } : catalog(body)));
  const t = createCanaryReadOnlyTransport(okEnv(), fetchImpl);
  await assert.rejects(pre.runCanaryPreflight({ env: okEnv(), executeReadOnlyQuery: t.executeReadOnlyQuery }), (e) => e.code === "TRANSPORT_HTTP_ERROR" && /pgcrypto: HTTP 500/.test(e.message));
});

test("authorization failure (403) during preflight surfaces as AUTH_REJECTED", async () => {
  const { fetchImpl } = makeFakeFetch(() => ({ status: 403, text: '{"message":"Missing required permission(s)"}' }));
  const t = createCanaryReadOnlyTransport(okEnv(), fetchImpl);
  await assert.rejects(pre.runCanaryPreflight({ env: okEnv(), executeReadOnlyQuery: t.executeReadOnlyQuery }), (e) => e.code === "AUTH_REJECTED");
});

test("every preflight SQL constant is a single read-only SELECT", () => {
  const sqls = [
    pre.SQL_SESSION, pre.SQL_IDENTITY, pre.SQL_PUBLIC_INVENTORY, pre.SQL_HISTORY_TABLE, pre.SQL_HISTORY_COUNT,
    pre.SQL_PGCRYPTO, pre.SQL_RESIDUE, pre.SQL_POST_MIGRATION_CONTRACT, sentinel.SQL_SENTINEL_PRESENCE,
    sentinel.CANARY_SENTINEL_VERIFICATION_SQL, plan.SQL_DEFAULT_ACL_API_ROLE_GRANTS, ...Object.values(plan.STEP_MARKER_SQL),
  ];
  for (const sql of sqls) {
    assert.match(sql, /^select\b/i);
    assert.ok(!sql.includes(";"), "single statement");
    assert.doesNotMatch(sql, /\b(insert|update|delete|create|drop|alter|grant|revoke|truncate)\s/i);
  }
});

test("CLI argument parsing requires the exact read-only phrase", () => {
  assert.doesNotThrow(() => parsePreflightCliArgs([`--confirm=${pre.CANARY_PREFLIGHT_CONFIRMATION_PHRASE}`]));
  assert.throws(() => parsePreflightCliArgs([]), (e) => e.code === "INVALID_ARGS");
  assert.throws(() => parsePreflightCliArgs(["--confirm=yes"]), (e) => e.code === "CONFIRMATION_REQUIRED");
  assert.throws(() => parsePreflightCliArgs([`--confirm=${pre.CANARY_PREFLIGHT_CONFIRMATION_PHRASE}`, "x"]), (e) => e.code === "INVALID_ARGS");
});
