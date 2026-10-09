// Migration 0067 (service_role CRUD grants for Central KB) + the apply-0067
// step — static checks and mocked runner behavior. PURE: no network, no
// database; fixture secrets only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { A7_PROJECT_REF, A7_SUPABASE_URL, FORBIDDEN_PRODUCTION_REF, A7GuardError } = await import("@/lib/a7-guard");
const { A7SentinelGuardError } = await import("@/lib/a7-sentinel-guard");
const { A7_STEPS, A7_LIVE_CONFIRMATION_PHRASE, runLiveStep, runDryRun, validateStepManifest } =
  await import("../scripts/a7-mutate-lib.ts");

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const FILE = "0067_central_knowledge_grants.sql";
const raw = fs.readFileSync(path.join(migrationsDir, FILE), "utf8");
// Code only: strip comments so prose cannot satisfy or trip any check.
const sql = raw.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim().toLowerCase();
const FAKE_SENTINEL = "11111111-2222-4333-8444-555555555555";
const CONFIRM = A7_LIVE_CONFIRMATION_PHRASE;

const realDisk = () =>
  fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(migrationsDir, file))).digest("hex") }));

test("0067 contains exactly the intended GRANT and nothing else", () => {
  // (1) exactly one statement
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  assert.equal(statements.length, 1, "exactly one SQL statement");
  const stmt = statements[0];
  assert.match(stmt, /^grant /);
  // (3) exactly SELECT, INSERT, UPDATE, DELETE
  const privs = stmt.slice("grant ".length, stmt.indexOf(" on ")).split(",").map((p) => p.trim()).sort();
  assert.deepEqual(privs, ["delete", "insert", "select", "update"]);
  // (4) exactly the three Central KB tables
  const onPart = stmt.slice(stmt.indexOf(" on ") + 4, stmt.indexOf(" to "));
  const tables = onPart.replace(/^table /, "").split(",").map((t) => t.trim()).sort();
  assert.deepEqual(tables, [
    "public.agent_knowledge_resources",
    "public.knowledge_documents",
    "public.knowledge_resources",
  ]);
  // (2) only service_role receives privileges
  const toPart = stmt.slice(stmt.indexOf(" to ") + 4).trim();
  assert.equal(toPart, "service_role");
});

test("0067 changes nothing it must not change", () => {
  // (5) no anon/authenticated grants, (6) no a7_guard, (10) no production ref
  assert.doesNotMatch(sql, /anon|authenticated|public_role|\bpublic\b(?!\.)/, "no browser-role tokens in code");
  assert.ok(!sql.includes("a7_guard"));
  assert.ok(!raw.includes(FORBIDDEN_PRODUCTION_REF));
  // (7) no RLS/policy changes, (8) no default-privilege changes,
  // (9) no SECURITY changes, no DDL, no revoke
  assert.doesNotMatch(sql, /policy|row level security|default privileges|security definer|security invoker/);
  assert.doesNotMatch(sql, /\b(create|alter|drop|revoke|truncate|insert into|update .* set|delete from)\b/);
});

test("apply-0067 step: exactly one migration, pinned hash matches disk, no chaining", () => {
  // (11) exactly one migration in the step
  assert.deepEqual(A7_STEPS["apply-0067"].migrations.map((m) => m.file), [FILE]);
  const diskHash = createHash("sha256").update(fs.readFileSync(path.join(migrationsDir, FILE))).digest("hex");
  assert.equal(A7_STEPS["apply-0067"].migrations[0].sha256, diskHash, "pinned hash matches disk");
  // (12)(13) steps are disjoint and 0066 is untouched and independently selectable
  assert.deepEqual(A7_STEPS["apply-0066"].migrations.map((m) => m.file), ["0066_clinic_scheduling.sql"]);
  assert.ok(!A7_STEPS["apply-0066"].migrations.some((m) => m.file === FILE));
  assert.ok(!A7_STEPS["baseline-0001-0064"].migrations.some((m) => m.file === FILE));
  assert.ok(!A7_STEPS["apply-0065"].migrations.some((m) => m.file === FILE));
  // (14) 0065 pin unchanged
  assert.equal(
    A7_STEPS["apply-0065"].migrations[0].sha256,
    "7976604d40146bd3dbf1b0db0a645ff3c06e3e9209b9651a92b2411a11196263",
  );
  // (15) every pinned hash (baseline, 0065, 0066, 0067) still matches disk
  const disk = new Map(realDisk().map((d) => [d.file, d.sha256]));
  for (const step of Object.values(A7_STEPS)) {
    for (const m of step.migrations) assert.equal(disk.get(m.file), m.sha256, m.file);
  }
  // (16) closed world includes 0067: validation passes with it on disk and in a step...
  validateStepManifest("apply-0067", realDisk());
  // ...and 0066 validates independently with 0067 present on disk
  validateStepManifest("apply-0066", realDisk());
});

test("mocked live flow for apply-0067: guards first, sentinel before mutation, exactly one file, stop on failure", async () => {
  const env = { A7_MODE: "1", A7_EXPECTED_REF: A7_PROJECT_REF, NEXT_PUBLIC_SUPABASE_URL: A7_SUPABASE_URL, A7_SENTINEL_TOKEN: FAKE_SENTINEL };
  // (17) production blocked before transport
  let calls = 0;
  await assert.rejects(
    runLiveStep({
      confirmation: CONFIRM,
      stepId: "apply-0067",
      env: { ...env, NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` },
      readDisk: realDisk,
      readSql: () => "-- sql",
      executeSentinelQuery: async () => { calls++; return []; },
      executeMutation: async () => { calls++; },
    }),
    (e) => e instanceof A7GuardError && e.code === "PRODUCTION_TARGET_BLOCKED",
  );
  assert.equal(calls, 0);
  // (18) sentinel failure prevents the mutation
  let mutations = 0;
  await assert.rejects(
    runLiveStep({
      confirmation: CONFIRM,
      stepId: "apply-0067",
      env,
      readDisk: realDisk,
      readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
      executeSentinelQuery: async () => [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: false }],
      executeMutation: async () => { mutations++; },
    }),
    (e) => e instanceof A7SentinelGuardError,
  );
  assert.equal(mutations, 0);
  // happy path: authorize, then EXACTLY the one 0067 file — nothing chains after
  const events = [];
  const result = await runLiveStep({
    confirmation: CONFIRM,
    stepId: "apply-0067",
    env,
    readDisk: realDisk,
    readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
    executeSentinelQuery: async () => { events.push("authorize"); return [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: true }]; },
    executeMutation: async (s, file) => { events.push(`mutate:${file}`); },
  });
  assert.deepEqual(events, ["authorize", `mutate:${FILE}`]);
  assert.deepEqual(result.applied, [FILE]);
  // (19) a failing 0067 mutation stops closed with nothing applied after it
  await assert.rejects(
    runLiveStep({
      confirmation: CONFIRM,
      stepId: "apply-0067",
      env,
      readDisk: realDisk,
      readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
      executeSentinelQuery: async () => [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: true }],
      executeMutation: async () => { throw new Error("boom"); },
    }),
  );
});

test("dry-run apply-0067 performs zero HTTP and passes static checks", () => {
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches++; throw new Error("network use attempted"); };
  try {
    const report = runDryRun({
      stepId: "apply-0067",
      readDisk: realDisk,
      readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
      readEnvFile: () => [
        "A7_MODE=1",
        `A7_EXPECTED_REF=${A7_PROJECT_REF}`,
        `NEXT_PUBLIC_SUPABASE_URL=${A7_SUPABASE_URL}`,
        `A7_SENTINEL_TOKEN=${FAKE_SENTINEL}`,
        "A7_SUPABASE_MGMT_TOKEN=sbp_FAKE_fixture_management_token_000",
      ].join("\n"),
    });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
});
