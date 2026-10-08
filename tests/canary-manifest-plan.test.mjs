// Canary migration checksum verification + execution plan — PURE OFFLINE tests.
// Uses the REAL committed migrations and manifest, plus tampered copies.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const m = await import("../scripts/canary-manifest-check.ts");
const plan = await import("../scripts/canary-plan-lib.ts");
const { A7_STEPS } = await import("../scripts/a7-manifest.ts");
const { CanaryError } = await import("../scripts/canary-guard.ts");

const root = path.resolve(import.meta.dirname, "..");
const migDir = path.join(root, "supabase", "migrations");
const manifestSource = fs.readFileSync(path.join(root, "scripts", "a7-manifest.ts"), "utf8");
const disk = m.readMigrationDisk(migDir);
const readSql = (f) => (fs.existsSync(path.join(migDir, f)) ? fs.readFileSync(path.join(migDir, f), "utf8") : ""); // fake stray files read as empty
const real = () => ({ manifestSource, disk, readSql });
const failed = (report) => report.checks.filter((c) => !c.ok).map((c) => c.name);

// ------------------------------------------------------------ checksums

test("the committed 68-file manifest verifies completely", () => {
  const r = m.verifyCanaryManifest(real());
  assert.equal(r.ok, true, JSON.stringify(failed(r)));
  assert.equal(disk.length, 68);
  assert.deepEqual(r.steps.map((s) => s.stepId), ["baseline-0001-0064", "apply-0065", "apply-0067", "apply-0066", "apply-0068"]);
  assert.deepEqual(r.steps.map((s) => s.migrations.length), [64, 1, 1, 1, 1]);
});

test("manifest source must be the reviewed byte-for-byte file", () => {
  const r = m.verifyCanaryManifest({ ...real(), manifestSource: manifestSource + "\n" });
  assert.equal(r.ok, false);
  assert.deepEqual(failed(r), ["manifest source is the reviewed hash-pinned file"]);
  assert.deepEqual(r.steps, []);
  assert.throws(() => m.assertCanaryManifest(r), (e) => e instanceof CanaryError && e.code === "MANIFEST_SOURCE_CHANGED");
});

test("a changed migration byte is a HASH_MISMATCH", () => {
  const tampered = disk.map((d) => (d.file === "0068_knowledge_chunks.sql" ? { ...d, sha256: m.sha256Hex(readSql(d.file) + " ") } : d));
  const r = m.verifyCanaryManifest({ ...real(), disk: tampered });
  assert.equal(r.ok, false);
  const c = r.checks.find((x) => x.name.startsWith("step apply-0068"));
  assert.equal(c.ok, false);
  assert.match(c.detail, /HASH_MISMATCH: 0068_knowledge_chunks\.sql/);
  assert.throws(() => m.assertCanaryManifest(r), (e) => e.code === "MANIFEST_INVALID");
});

test("missing, stray and duplicate-prefix files all fail closed", () => {
  const missing = m.verifyCanaryManifest({ ...real(), disk: disk.filter((d) => d.file !== "0067_central_knowledge_grants.sql") });
  assert.equal(missing.ok, false);
  assert.match(missing.checks.find((c) => c.name.startsWith("step apply-0067")).detail, /MISSING_MIGRATION/);

  const stray = m.verifyCanaryManifest({ ...real(), disk: [...disk, { file: "0069_extra.sql", sha256: "0".repeat(64) }] });
  assert.equal(stray.ok, false);
  assert.ok(stray.checks.filter((c) => !c.ok).some((c) => /EXTRA_MIGRATION/.test(c.detail ?? "")));

  const dup = m.verifyCanaryManifest({ ...real(), disk: [...disk, { file: "0061_clinic_scheduling.sql", sha256: "0".repeat(64) }] });
  assert.equal(dup.ok, false);
  assert.ok(dup.checks.some((c) => /DUPLICATE_PREFIX/.test(c.detail ?? "")));
});

test("a migration referencing a guard schema is refused", () => {
  for (const schema of ["a7_guard", "canary_guard"]) {
    const r = m.verifyCanaryManifest({ ...real(), readSql: (f) => (f === "0030_team_chats_brand.sql" ? `${readSql(f)}\n-- ${schema}.sentinel` : readSql(f)) });
    assert.equal(r.ok, false);
    assert.deepEqual(failed(r), ["no migration references a guard schema (a7_guard / canary_guard)"]);
    assert.throws(() => m.assertCanaryManifest(r), (e) => e.code === "GUARD_SCHEMA_REFERENCED");
  }
});

test("reviewed step order matches the manifest object order", () => {
  assert.deepEqual(Object.keys(A7_STEPS), [...m.CANARY_STEP_ORDER]);
});

// ------------------------------------------------------------ transaction-safety scan

test("PL/pgSQL begin inside dollar quotes, comments and strings is not transaction control", () => {
  const sql = [
    "-- begin; commit;",
    "/* begin; /* nested */ commit; */",
    "do $$ begin perform 1; end $$;",
    "do $body$ begin raise notice 'x;'; end $body$;",
    "select 'begin; commit;' as s, E'it\\'s; begin' as e, \"commit\" from t;",
    "create table x (id int);",
  ].join("\n");
  const r = plan.scanTransactionSafety(sql);
  assert.equal(r.wrapSafe, true, JSON.stringify(r.blocking));
  assert.equal(r.statementCount, 4);
});

test("top-level transaction control and non-transactional statements are blocking", () => {
  for (const [sql, re] of [
    ["begin; create table a(id int); commit;", /transaction control \(BEGIN\)/],
    ["create table a(id int); commit;", /COMMIT/],
    ["create index concurrently i on a(id);", /CONCURRENTLY/],
    ["vacuum analyze a;", /VACUUM/],
    ["alter system set work_mem = '1MB';", /ALTER SYSTEM/],
    ["create function f() returns int language sql begin atomic select 1; end;", /BEGIN ATOMIC/],
  ]) {
    const r = plan.scanTransactionSafety(sql);
    assert.equal(r.wrapSafe, false, sql);
    assert.ok(r.blocking.some((b) => re.test(b)), `${sql} -> ${JSON.stringify(r.blocking)}`);
  }
  const caution = plan.scanTransactionSafety("alter type t add value 'x';");
  assert.equal(caution.wrapSafe, true);
  assert.equal(caution.cautions.length, 1);
});

test("all 68 committed migrations scan as transaction-wrappable", () => {
  const unsafe = disk.map((d) => [d.file, plan.scanTransactionSafety(readSql(d.file))]).filter(([, r]) => !r.wrapSafe);
  assert.deepEqual(unsafe.map(([f, r]) => `${f}: ${r.blocking.join("; ")}`), []);
});

// ------------------------------------------------------------ the plan

test("plan: preflight, sentinel, hardening, the 5 manifest steps in order, post-validation, functional", () => {
  const p = plan.buildCanaryExecutionPlan(real());
  assert.equal(p.ok, true, JSON.stringify(p.blockers));
  assert.equal(p.target, "thqjtoxzkujnljsmkwkp");
  assert.deepEqual(p.phases.map((x) => x.id), ["P0", "P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9"]);
  assert.ok(p.phases.every((x) => x.executes === false), "nothing executes");
  assert.deepEqual(
    p.phases.filter((x) => x.stepId).map((x) => x.stepId),
    ["baseline-0001-0064", "apply-0065", "apply-0067", "apply-0066", "apply-0068"],
  );
  const reqs = p.phases.flatMap((x) => x.requests);
  assert.equal(reqs.length, 68);
  assert.deepEqual(reqs.map((r) => r.order), Array.from({ length: 68 }, (_, i) => i + 1));
  // Manifest pins carried through verbatim.
  const pinned = new Map(Object.values(A7_STEPS).flatMap((s) => s.migrations.map((x) => [x.file, x.sha256])));
  for (const r of reqs) assert.equal(r.sha256, pinned.get(r.file));
  // Dependency order inside the plan.
  const idx = (f) => reqs.findIndex((r) => r.file === f);
  assert.ok(idx("0064_voice_number_routing.sql") < idx("0065_central_knowledge.sql"));
  assert.ok(idx("0065_central_knowledge.sql") < idx("0067_central_knowledge_grants.sql"));
  assert.ok(idx("0067_central_knowledge_grants.sql") < idx("0068_knowledge_chunks.sql"));
  // Hardening precedes the baseline; every write phase has its own gate.
  assert.ok(p.phases.findIndex((x) => x.id === "P2") < p.phases.findIndex((x) => x.stepId === "baseline-0001-0064"));
  for (const w of p.phases.filter((x) => x.kind === "write")) assert.match(w.approvalGate, /^separate approval/);
  assert.ok(p.rollback.some((r) => /UNVERIFIED/.test(r)), "rollback states the write-path uncertainty");
});

test("plan refuses to build phases when the manifest fails", () => {
  const p = plan.buildCanaryExecutionPlan({ ...real(), manifestSource: "tampered" });
  assert.equal(p.ok, false);
  assert.deepEqual(p.phases, []);
  assert.ok(p.blockers[0].startsWith("manifest:"));
});

test("plan reports a transaction-unsafe migration as a blocker", () => {
  const p = plan.buildCanaryExecutionPlan({
    ...real(),
    readSql: (f) => (f === "0066_clinic_scheduling.sql" ? `${readSql(f)}\ncreate index concurrently i on public.x(id);` : readSql(f)),
  });
  assert.equal(p.ok, false);
  assert.ok(p.blockers.some((b) => b.startsWith("0066_clinic_scheduling.sql") && /CONCURRENTLY/.test(b)));
});

test("privilege hardening proposal targets tables and sequences for the A7 posture only", () => {
  const sql = plan.PROPOSED_PRIVILEGE_HARDENING_SQL;
  assert.match(sql, /^begin;[\s\S]*commit;$/);
  assert.match(sql, /revoke all on tables from anon, authenticated, service_role/);
  assert.match(sql, /revoke all on sequences from anon, authenticated, service_role/);
  assert.doesNotMatch(sql, /\bon functions\b/, "function defaults are an open question, not silently changed");
  assert.doesNotMatch(sql, /\bgrant\b/i);
});

test("wrapInTransaction produces one explicit transaction around the file", () => {
  assert.equal(plan.wrapInTransaction("create table a(id int);"), "begin;\ncreate table a(id int);\ncommit;\n");
});
