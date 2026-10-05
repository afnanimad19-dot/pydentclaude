// A7 mutation runner — fail-closed infrastructure tests. PURE: all transports
// are mocks, no HTTP, no Supabase, and only obvious fake fixture secrets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { A7_PROJECT_REF, A7_SUPABASE_URL, FORBIDDEN_PRODUCTION_REF, A7GuardError } = await import("@/lib/a7-guard");
const { A7SentinelGuardError } = await import("@/lib/a7-sentinel-guard");
const lib = await import("../scripts/a7-mutate-lib.ts");
const {
  A7_STEPS,
  A7_QUERY_ENDPOINT,
  A7_LIVE_CONFIRMATION_PHRASE,
  ENV_A7_ALLOWED_KEYS,
  parseCliArgs,
  parseEnvA7,
  validateA7EnvConfig,
  validateStepManifest,
  checkSentinelProtection,
  runDryRun,
  runLiveStep,
  A7RunnerError,
} = lib;
const CONFIRM = A7_LIVE_CONFIRMATION_PHRASE;

const root = path.resolve(import.meta.dirname, "..");
const migrationsDir = path.join(root, "supabase", "migrations");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Fake fixture secrets — never real values.
const FAKE_SENTINEL = "11111111-2222-4333-8444-555555555555";
const FAKE_MGMT = "sbp_FAKE_fixture_management_token_000";

const realDisk = () =>
  fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sha256: sha256(fs.readFileSync(path.join(migrationsDir, file))) }));

const envFileContent = () =>
  [
    "# fixture",
    "A7_MODE=1",
    `A7_EXPECTED_REF=${A7_PROJECT_REF}`,
    `NEXT_PUBLIC_SUPABASE_URL=${A7_SUPABASE_URL}`,
    `A7_SENTINEL_TOKEN=${FAKE_SENTINEL}`,
    `A7_SUPABASE_MGMT_TOKEN=${FAKE_MGMT}`,
  ].join("\n");

const dryDeps = (overrides = {}) => ({
  stepId: "baseline-0001-0064",
  readDisk: realDisk,
  readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
  readEnvFile: () => envFileContent(),
  ...overrides,
});

const expectRunnerError = (fn, code) =>
  assert.throws(fn, (e) => e instanceof A7RunnerError && e.code === code, code);

test("dry-run default performs ZERO HTTP requests and passes against the real repo", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = () => {
    fetchCalls++;
    throw new Error("network use attempted");
  };
  try {
    for (const stepId of Object.keys(A7_STEPS)) {
      const report = runDryRun(dryDeps({ stepId }));
      assert.equal(report.ok, true, `${stepId}: ${JSON.stringify(report.checks)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCalls, 0);
  // The runner library cannot even reach the network: no network API appears in it.
  const src = fs.readFileSync(path.join(root, "scripts", "a7-mutate-lib.ts"), "utf8");
  assert.doesNotMatch(src, /fetch\s*\(|node:https?|XMLHttpRequest|axios|undici/);
});

test("CLI accepts only an allowlisted step id — no SQL, no flags, no file paths", () => {
  assert.deepEqual(parseCliArgs(["apply-0065"]), { stepId: "apply-0065", dryRun: true });
  assert.deepEqual(parseCliArgs(["baseline-0001-0064", "--dry-run"]), { stepId: "baseline-0001-0064", dryRun: true });
  expectRunnerError(() => parseCliArgs([]), "INVALID_ARGS");
  expectRunnerError(() => parseCliArgs(["apply-0065", "apply-0066"]), "INVALID_ARGS");
  expectRunnerError(() => parseCliArgs(["--sql", "drop table x"]), "INVALID_ARGS");
  expectRunnerError(() => parseCliArgs(["--query=select 1"]), "INVALID_ARGS");
  expectRunnerError(() => parseCliArgs(["--live", "apply-0065"]), "INVALID_ARGS");
  expectRunnerError(() => parseCliArgs(["not-a-step"]), "UNKNOWN_STEP");
  expectRunnerError(() => parseCliArgs(["supabase/migrations/0001_init.sql"]), "UNKNOWN_STEP");
  expectRunnerError(() => parseCliArgs(["../../etc/passwd"]), "UNKNOWN_STEP");
  expectRunnerError(() => parseCliArgs(["select 1;"]), "UNKNOWN_STEP");
});

test("production ref cannot be selected or targeted", async () => {
  // Step ids and manifest carry no production reference; the endpoint is pinned.
  assert.equal(A7_QUERY_ENDPOINT, `https://api.supabase.com/v1/projects/${A7_PROJECT_REF}/database/query`);
  assert.ok(!A7_QUERY_ENDPOINT.includes(FORBIDDEN_PRODUCTION_REF));
  assert.ok(!JSON.stringify(A7_STEPS).includes(FORBIDDEN_PRODUCTION_REF));
  expectRunnerError(() => parseCliArgs([FORBIDDEN_PRODUCTION_REF]), "UNKNOWN_STEP");
  // A production-targeting env refuses in the live path before any transport call.
  let sentinelCalls = 0;
  let mutations = 0;
  await assert.rejects(
    runLiveStep({
      confirmation: CONFIRM,
      stepId: "apply-0065",
      env: {
        A7_MODE: "1",
        A7_EXPECTED_REF: A7_PROJECT_REF,
        NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co`,
        A7_SENTINEL_TOKEN: FAKE_SENTINEL,
      },
      readDisk: realDisk,
      readSql: () => "-- sql",
      executeSentinelQuery: async () => { sentinelCalls++; return []; },
      executeMutation: async () => { mutations++; },
    }),
    (e) => e instanceof A7GuardError && e.code === "PRODUCTION_TARGET_BLOCKED",
  );
  assert.equal(sentinelCalls, 0);
  assert.equal(mutations, 0);
});

test("baseline contains exactly 0001-0064; 0065 and 0066 are excluded; steps cover the disk exactly", () => {
  const baseline = A7_STEPS["baseline-0001-0064"].migrations.map((m) => m.file);
  assert.equal(baseline.length, 64);
  const prefixes = baseline.map((f) => Number(f.slice(0, 4)));
  assert.deepEqual(prefixes, Array.from({ length: 64 }, (_, i) => i + 1)); // 1..64, in order
  assert.ok(!baseline.some((f) => f.startsWith("0065") || f.startsWith("0066")));
  assert.deepEqual(A7_STEPS["apply-0065"].migrations.map((m) => m.file), ["0065_central_knowledge.sql"]);
  assert.deepEqual(A7_STEPS["apply-0066"].migrations.map((m) => m.file), ["0066_clinic_scheduling.sql"]);
  // The three steps together equal the real migrations directory exactly.
  const allStepFiles = Object.values(A7_STEPS).flatMap((s) => s.migrations.map((m) => m.file)).sort();
  assert.deepEqual(allStepFiles, realDisk().map((d) => d.file));
});

test("manifest hashes match the real approved files (hash-pinning is live)", () => {
  const disk = new Map(realDisk().map((d) => [d.file, d.sha256]));
  for (const step of Object.values(A7_STEPS)) {
    for (const m of step.migrations) assert.equal(disk.get(m.file), m.sha256, m.file);
  }
  // 0065 pin equals the long-approved hash from the A7 verification gate.
  assert.equal(
    A7_STEPS["apply-0065"].migrations[0].sha256,
    "7976604d40146bd3dbf1b0db0a645ff3c06e3e9209b9651a92b2411a11196263",
  );
});

test("duplicate prefix on disk is refused", () => {
  const disk = [...realDisk(), { file: "0061_evil_twin.sql", sha256: "0".repeat(64) }];
  expectRunnerError(() => validateStepManifest("baseline-0001-0064", disk), "DUPLICATE_PREFIX");
});

test("missing migration is refused", () => {
  const disk = realDisk().filter((d) => d.file !== "0042_clinic_timezone.sql");
  expectRunnerError(() => validateStepManifest("baseline-0001-0064", disk), "MISSING_MIGRATION");
});

test("extra/unexpected migration is refused — even for a step that does not include it", () => {
  const disk = [...realDisk(), { file: "0067_unknown.sql", sha256: "0".repeat(64) }];
  expectRunnerError(() => validateStepManifest("baseline-0001-0064", disk), "EXTRA_MIGRATION");
  expectRunnerError(() => validateStepManifest("apply-0065", disk), "EXTRA_MIGRATION");
  const weird = [...realDisk(), { file: "notes.sql", sha256: "0".repeat(64) }];
  expectRunnerError(() => validateStepManifest("apply-0066", weird), "EXTRA_MIGRATION");
});

test("changed hash is refused", () => {
  const disk = realDisk().map((d) =>
    d.file === "0010_wa_link_patient.sql" ? { ...d, sha256: "f".repeat(64) } : d,
  );
  expectRunnerError(() => validateStepManifest("baseline-0001-0064", disk), "HASH_MISMATCH");
});

test("migration order is deterministic: disk listing order cannot change execution order", () => {
  const shuffled = [...realDisk()].reverse();
  const manifest = validateStepManifest("baseline-0001-0064", shuffled);
  assert.deepEqual(
    manifest.map((m) => Number(m.file.slice(0, 4))),
    Array.from({ length: 64 }, (_, i) => i + 1),
  );
});

test("a7_guard reference in migration SQL is refused (sentinel protection)", () => {
  checkSentinelProtection("ok.sql", "create table if not exists public.x (id int);");
  for (const sql of [
    "drop schema a7_guard cascade;",
    "alter table A7_GUARD.sentinel drop column token;",
    "grant usage on schema a7_guard to anon;",
    "-- touch a7_guard later",
  ]) {
    expectRunnerError(() => checkSentinelProtection("evil.sql", sql), "SENTINEL_PROTECTION");
  }
  // And through the dry run:
  const report = runDryRun(dryDeps({ stepId: "apply-0066", readSql: () => "select * from a7_guard.sentinel" }));
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => !c.ok && c.detail?.includes("SENTINEL_PROTECTION")));
});

test(".env.a7 is the only secret source: no fallback, strict keys, shape-checked values", () => {
  // Missing file fails the config check even with a fully valid process-style env around.
  const report = runDryRun(dryDeps({ readEnvFile: () => null }));
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.detail === "ENV_FILE_MISSING"));
  // Missing sentinel token.
  expectRunnerError(
    () => parseEnvA7(envFileContent().replace(/^A7_SENTINEL_TOKEN=.*$/m, "")),
    "ENV_MISSING_KEY",
  );
  // Malformed sentinel token.
  expectRunnerError(
    () => parseEnvA7(envFileContent().replace(FAKE_SENTINEL, "not-a-uuid")),
    "ENV_BAD_VALUE",
  );
  // Missing Management API credential (required for the future live path).
  expectRunnerError(
    () => parseEnvA7(envFileContent().replace(/^A7_SUPABASE_MGMT_TOKEN=.*$/m, "")),
    "ENV_MISSING_KEY",
  );
  // Unknown and duplicate keys fail closed; junk lines fail closed.
  expectRunnerError(() => parseEnvA7(envFileContent() + "\nA7_SENTNEL_TOKEN=typo"), "ENV_UNKNOWN_KEY");
  expectRunnerError(() => parseEnvA7(envFileContent() + "\nA7_MODE=1"), "ENV_DUPLICATE_KEY");
  expectRunnerError(() => parseEnvA7("garbage line"), "ENV_PARSE_ERROR");
  // Identity guard runs over the parsed file (production ref there is refused).
  expectRunnerError(
    () => validateA7EnvConfig(parseEnvA7(envFileContent().replace(A7_SUPABASE_URL, `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co`))),
    "CONFIG_INVALID",
  );
  assert.deepEqual([...ENV_A7_ALLOWED_KEYS].sort(), [
    "A7_EXPECTED_REF", "A7_MODE", "A7_SENTINEL_TOKEN", "A7_SUPABASE_MGMT_TOKEN", "NEXT_PUBLIC_SUPABASE_URL",
  ]);
});

test("guard failure prevents any executor call; sentinel failure prevents mutation", async () => {
  const calls = { sentinel: 0, mutate: 0 };
  const deps = (env, sentinelRow) => ({
    confirmation: CONFIRM,
    stepId: "apply-0065",
    env,
    readDisk: realDisk,
    readSql: (f) => fs.readFileSync(path.join(migrationsDir, f), "utf8"),
    executeSentinelQuery: async () => { calls.sentinel++; return sentinelRow; },
    executeMutation: async () => { calls.mutate++; },
  });
  // Identity failure: nothing is called.
  await assert.rejects(runLiveStep(deps({ A7_SENTINEL_TOKEN: FAKE_SENTINEL }, [])), (e) => e instanceof A7GuardError);
  assert.deepEqual(calls, { sentinel: 0, mutate: 0 });
  // Sentinel failure (wrong token): sentinel queried once, mutation never runs.
  const env = { A7_MODE: "1", A7_EXPECTED_REF: A7_PROJECT_REF, NEXT_PUBLIC_SUPABASE_URL: A7_SUPABASE_URL, A7_SENTINEL_TOKEN: FAKE_SENTINEL };
  await assert.rejects(
    runLiveStep(deps(env, [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: false }])),
    (e) => e instanceof A7SentinelGuardError && e.code === "SENTINEL_TOKEN_MISMATCH",
  );
  assert.deepEqual(calls, { sentinel: 1, mutate: 0 });
});

test("mocked future-live flow: authorization immediately precedes mutation, one step only, manifest order", async () => {
  const events = [];
  const env = { A7_MODE: "1", A7_EXPECTED_REF: A7_PROJECT_REF, NEXT_PUBLIC_SUPABASE_URL: A7_SUPABASE_URL, A7_SENTINEL_TOKEN: FAKE_SENTINEL };
  const result = await runLiveStep({
    confirmation: CONFIRM,
    stepId: "baseline-0001-0064",
    env,
    readDisk: realDisk,
    readSql: (f) => `-- ${f}`,
    executeSentinelQuery: async () => {
      events.push("authorize");
      return [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: true }];
    },
    executeMutation: async (sql, file, auth) => {
      assert.equal(auth.eligible, true); // mutation is unreachable without the authorization value
      events.push(`mutate:${file}`);
    },
  });
  assert.equal(events[0], "authorize");
  assert.equal(events[1], "mutate:0001_init.sql"); // nothing between authorization and first mutation
  assert.equal(events.length, 1 + 64); // one authorization, exactly the step's 64 mutations
  assert.deepEqual(result.applied, A7_STEPS["baseline-0001-0064"].migrations.map((m) => m.file));
});

test("live execution requires the exact confirmation phrase — refused without it, before any work", async () => {
  const env = { A7_MODE: "1", A7_EXPECTED_REF: A7_PROJECT_REF, NEXT_PUBLIC_SUPABASE_URL: A7_SUPABASE_URL, A7_SENTINEL_TOKEN: FAKE_SENTINEL };
  for (const confirmation of [undefined, "", "yes", "--confirm", CONFIRM.toLowerCase(), CONFIRM + " ", CONFIRM.slice(0, -1)]) {
    let touched = 0;
    await assert.rejects(
      runLiveStep({
        confirmation,
        stepId: "apply-0065",
        env,
        readDisk: () => { touched++; return realDisk(); },
        readSql: () => { touched++; return "-- sql"; },
        executeSentinelQuery: async () => { touched++; return []; },
        executeMutation: async () => { touched++; },
      }),
      (e) => e instanceof A7RunnerError && e.code === "LIVE_CONFIRMATION_REQUIRED",
      String(confirmation),
    );
    assert.equal(touched, 0, "nothing runs without the exact phrase");
  }
  // The phrase itself is non-secret and fixed; the dry-run CLI never grants it.
  const cliSrc = fs.readFileSync(path.join(root, "scripts", "a7-mutate.ts"), "utf8");
  assert.ok(!cliSrc.includes("runLiveStep"), "dry-run CLI must not reference the live path");
  assert.ok(!cliSrc.includes("A7_LIVE_CONFIRMATION_PHRASE"), "dry-run CLI must not carry the confirmation");
  assert.doesNotMatch(cliSrc, /fetch\s*\(|node:https?|Authorization/);
});

test("no secret value ever appears in reports, logs, or errors", async () => {
  const outputs = [];
  // Dry-run report text with fake secrets present in .env.a7:
  outputs.push(JSON.stringify(runDryRun(dryDeps())));
  // Every env failure message:
  for (const content of [
    envFileContent().replace(FAKE_SENTINEL, "not-a-uuid"),
    envFileContent() + "\nEVIL_KEY=" + FAKE_MGMT,
  ]) {
    try { parseEnvA7(content); } catch (e) { outputs.push(`${e.message} ${e.stack ?? ""}`); }
  }
  // Live-path refusals:
  try {
    await runLiveStep({
      confirmation: CONFIRM,
      stepId: "apply-0065",
      env: { A7_MODE: "1", A7_EXPECTED_REF: A7_PROJECT_REF, NEXT_PUBLIC_SUPABASE_URL: A7_SUPABASE_URL, A7_SENTINEL_TOKEN: FAKE_SENTINEL, A7_SUPABASE_MGMT_TOKEN: FAKE_MGMT },
      readDisk: realDisk,
      readSql: () => "-- sql",
      executeSentinelQuery: async () => { throw new Error(`transport blob ${FAKE_MGMT} ${FAKE_SENTINEL}`); },
      executeMutation: async () => {},
    });
  } catch (e) {
    outputs.push(`${e.message} ${e.stack ?? ""}`);
  }
  for (const text of outputs) {
    assert.ok(!text.includes(FAKE_SENTINEL), "sentinel token leaked");
    assert.ok(!text.includes(FAKE_MGMT), "management token leaked");
  }
});

test("normal application runtime imports none of the runner code", () => {
  const offenders = [];
  const scan = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(p);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const src = fs.readFileSync(p, "utf8");
        if (/a7-mutate|a7-manifest|scripts\//.test(src)) offenders.push(p);
      }
    }
  };
  scan(path.join(root, "src"));
  assert.deepEqual(offenders, []);
  for (const f of ["next.config.ts"]) {
    assert.ok(!fs.readFileSync(path.join(root, f), "utf8").includes("a7-mutate"), f);
  }
});
