// Canary P3 migration step orchestration — PURE OFFLINE tests. The probe is a
// recording fake (no fetch anywhere); the read-only executor is scripted; the
// manifest, disk listing and SQL contents are the real repository files.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { okEnv, FAKE_SENTINEL_TOKEN } from "./canary-fixtures.mjs";

const guard = await import("../scripts/canary-guard.ts");
const manifest = await import("../scripts/a7-manifest.ts");
const check = await import("../scripts/canary-manifest-check.ts");
const plan = await import("../scripts/canary-plan-lib.ts");
const preflight = await import("../scripts/canary-preflight-lib.ts");
const sentinel = await import("../scripts/canary-sentinel.ts");
const probeLib = await import("../scripts/canary-probe-lib.ts");
const lib = await import("../scripts/canary-migrate-lib.ts");
const cli = await import("../scripts/canary-migrate.ts");

const { CanaryMigrateError, runCanaryMigrationStep, SQL_P3_PUBLIC_OWNERSHIP, SQL_P3_PUBLIC_API_GRANTS } = lib;

const migrateStops = (code) => (e) => e instanceof CanaryMigrateError && e.code === code;
const guardStops = (code) => (e) => e instanceof guard.CanaryError && e.code === code;

const repoRoot = path.join(import.meta.dirname, "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");
const MANIFEST_SOURCE = fs.readFileSync(path.join(repoRoot, "scripts", "a7-manifest.ts"), "utf8");
const DISK = check.readMigrationDisk(migrationsDir);
const readSql = (file) => fs.readFileSync(path.join(migrationsDir, file), "utf8");

const FAKE_DIGEST = createHash("sha256").update(FAKE_SENTINEL_TOKEN.toLowerCase(), "utf8").digest("hex");
const migEnv = (extra = {}) => okEnv({ CANARY_SENTINEL_TOKEN: FAKE_SENTINEL_TOKEN, ...extra });

const BASELINE_FILES = manifest.A7_STEPS["baseline-0001-0064"].migrations;
const SENTINEL_OK = { row_count: 1, id_ok: true, ref_ok: true, token_ok: true };
const ACL_CLEAN = [{ objtype: "f", owner: "postgres", api_role_grantees: "anon" }];
const ACL_DIRTY = [...ACL_CLEAN, { objtype: "r", owner: "postgres", api_role_grantees: "anon,authenticated,service_role" }];

const MARKERS = {
  "baseline-0001-0064": { done: { m0001: true, m0014: true, m0064: true }, none: { m0001: false, m0014: false, m0064: false } },
  "apply-0065": {
    done: { resources: true, documents: true, assignments: true, apply_fn: true },
    none: { resources: false, documents: false, assignments: false, apply_fn: false },
    partial: { resources: true, documents: false, assignments: false, apply_fn: false },
  },
  "apply-0067": { done: { resources_crud: true, documents_crud: true, assignments_crud: true }, none: { resources_crud: false, documents_crud: false, assignments_crud: false } },
  "apply-0066": { done: { slot_minutes: true }, none: { slot_minutes: false } },
  "apply-0068": { done: { chunks: true, reindex_fn: true, match_fn: true }, none: { chunks: false, reindex_fn: false, match_fn: false } },
};

/**
 * Scripted read-only executor. `markers[stepId]` is a list consumed per query
 * of that step's marker SQL (last answer repeats). Other SQLs likewise.
 */
const mkReadOnly = ({
  markers = {},
  inventory = [{ relations: 0, functions: 0, types: 0 }],
  acl = [ACL_CLEAN],
  historyRows = [{ rows: 0 }],
  ownership = [{ not_postgres: 0 }],
  grants = [{ grants: 0 }],
  verification = [SENTINEL_OK],
} = {}) => {
  const counts = {};
  const next = (key, list) => {
    counts[key] = counts[key] ?? 0;
    const v = list[Math.min(counts[key], list.length - 1)];
    counts[key] += 1;
    return structuredClone(Array.isArray(v) ? v : [v]);
  };
  const markerSqlToStep = new Map(Object.entries(plan.STEP_MARKER_SQL).map(([stepId, sql]) => [sql, stepId]));
  const executor = async (sql, params) => {
    if (sql === sentinel.CANARY_SENTINEL_VERIFICATION_SQL) {
      assert.deepEqual(params, [FAKE_DIGEST]);
      return next("verification", verification);
    }
    if (sql === plan.SQL_DEFAULT_ACL_API_ROLE_GRANTS) return next("acl", acl);
    if (sql === preflight.SQL_HISTORY_TABLE) return next("historyTable", [{ present: true }]);
    if (sql === preflight.SQL_HISTORY_COUNT) return next("historyCount", historyRows);
    if (sql === preflight.SQL_PUBLIC_INVENTORY) return next("inventory", inventory);
    if (sql === SQL_P3_PUBLIC_OWNERSHIP) return next("ownership", ownership);
    if (sql === SQL_P3_PUBLIC_API_GRANTS) return next("grants", grants);
    const stepId = markerSqlToStep.get(sql);
    if (stepId) {
      const list = markers[stepId] ?? [MARKERS[stepId].none];
      return next(`markers:${stepId}`, list);
    }
    throw new Error(`unexpected read-only SQL in P3 flow: ${sql.slice(0, 60)}`);
  };
  return { executor, counts };
};

/** Recording fake transport; `respond(call, index)` scripts each migration send. */
const mkProbe = (respond = async () => ({ authorized: true, httpStatus: 201 })) => {
  const sends = [];
  return {
    sends,
    probe: {
      runManifestMigration: async (rawSql, file, sha256) => {
        const call = { rawSql, file, sha256 };
        sends.push(call);
        return respond(call, sends.length - 1);
      },
    },
  };
};

const run = ({ stepId, readOnlyParts, respond, env = migEnv(), readSqlImpl = readSql }) => {
  const ro = mkReadOnly(readOnlyParts);
  const { sends, probe } = mkProbe(respond);
  return {
    sends,
    ro,
    report: runCanaryMigrationStep({
      env,
      readOnly: ro.executor,
      probe,
      stepId,
      manifestSource: MANIFEST_SOURCE,
      disk: DISK,
      readSql: readSqlImpl,
    }),
  };
};

test("apply-0065 succeeds: one pinned file, full pre/post verification", async () => {
  const { sends, report } = run({
    stepId: "apply-0065",
    readOnlyParts: {
      markers: {
        "baseline-0001-0064": [MARKERS["baseline-0001-0064"].done],
        "apply-0065": [MARKERS["apply-0065"].none, MARKERS["apply-0065"].done],
      },
    },
  });
  const r = await report;
  assert.equal(r.outcome, "step_applied");
  assert.deepEqual(r.filesApplied, ["0065_central_knowledge.sql"]);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].sha256, manifest.A7_STEPS["apply-0065"].migrations[0].sha256);
  assert.equal(check.sha256Hex(sends[0].rawSql), sends[0].sha256, "the exact pinned bytes were sent");
  assert.ok(r.checks.every((c) => c.ok));
});

test("baseline succeeds: 64 requests in exact manifest order with ownership and grant post-checks", async () => {
  const { sends, report } = run({
    stepId: "baseline-0001-0064",
    readOnlyParts: {
      markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].none, MARKERS["baseline-0001-0064"].done] },
    },
  });
  const r = await report;
  assert.equal(r.outcome, "step_applied");
  assert.equal(r.filesApplied.length, 64);
  assert.deepEqual(sends.map((s) => s.file), BASELINE_FILES.map((m) => m.file), "manifest order, one request per file");
  assert.ok(r.checks.some((c) => c.name.includes("owned by postgres")));
  assert.ok(r.checks.some((c) => c.name.includes("no API-role table grants")));
});

test("out-of-order execution is refused before anything is sent", async () => {
  const { sends, report } = run({
    stepId: "apply-0067",
    readOnlyParts: { markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].none] } },
  });
  await assert.rejects(report, migrateStops("P3_PREDECESSOR_INCOMPLETE"));
  assert.equal(sends.length, 0);
});

test("duplicate application and partial state are refused before anything is sent", async () => {
  const dup = run({
    stepId: "apply-0065",
    readOnlyParts: {
      markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].done], "apply-0065": [MARKERS["apply-0065"].done] },
    },
  });
  await assert.rejects(dup.report, migrateStops("P3_STEP_ALREADY_APPLIED"));
  assert.equal(dup.sends.length, 0);

  const partial = run({
    stepId: "apply-0065",
    readOnlyParts: {
      markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].done], "apply-0065": [MARKERS["apply-0065"].partial] },
    },
  });
  await assert.rejects(partial.report, migrateStops("P3_STATE_PARTIAL"));
  assert.equal(partial.sends.length, 0);

  const interruptedBaseline = run({
    stepId: "baseline-0001-0064",
    readOnlyParts: {
      markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].none] },
      inventory: [{ relations: 5, functions: 0, types: 0 }],
    },
  });
  await assert.rejects(interruptedBaseline.report, migrateStops("P3_STATE_PARTIAL"));
  assert.equal(interruptedBaseline.sends.length, 0);
});

test("a tampered on-disk file is refused by its hash before any request", async () => {
  const tamperedRead = (file) => (file === "0065_central_knowledge.sql" ? `${readSql(file)}\n-- tampered` : readSql(file));
  const { sends, report } = run({
    stepId: "apply-0065",
    readOnlyParts: { markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].done], "apply-0065": [MARKERS["apply-0065"].none] } },
    readSqlImpl: tamperedRead,
  });
  await assert.rejects(report, migrateStops("P3_FILE_HASH_MISMATCH"));
  assert.equal(sends.length, 0);
});

test("missing sentinel token, privilege drift and non-empty history each refuse before anything is sent", async () => {
  const noToken = run({ stepId: "apply-0065", env: okEnv() });
  await assert.rejects(noToken.report, guardStops("SENTINEL_TOKEN_MISSING"));
  assert.equal(noToken.sends.length, 0);

  const drift = run({ stepId: "apply-0065", readOnlyParts: { acl: [ACL_DIRTY] } });
  await assert.rejects(drift.report, migrateStops("P3_ACL_NOT_HARDENED"));
  assert.equal(drift.sends.length, 0);

  const history = run({ stepId: "apply-0065", readOnlyParts: { historyRows: [{ rows: 3 }] } });
  await assert.rejects(history.report, migrateStops("P3_HISTORY_NOT_EMPTY"));
  assert.equal(history.sends.length, 0);
});

test("an HTTP failure mid-step stops at the failing file with state capture and no retry", async () => {
  const { sends, report } = run({
    stepId: "baseline-0001-0064",
    readOnlyParts: { markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].none] } },
    respond: async (call, i) => {
      if (i === 2) throw new probeLib.CanaryProbeError("PROBE_HTTP_ERROR", `${call.file}: HTTP 500`);
      return { authorized: true, httpStatus: 201 };
    },
  });
  const r = await report;
  assert.equal(r.outcome, "failed");
  assert.equal(r.failedAtFile, BASELINE_FILES[2].file);
  assert.deepEqual(r.filesApplied, BASELINE_FILES.slice(0, 2).map((m) => m.file));
  assert.equal(sends.length, 3, "stopped at the failing file; no retry, no next file");
  assert.ok(r.checks.some((c) => c.name.includes("state captured")));
});

test("markers that stay incomplete after execution fail the step post-check", async () => {
  const { report } = run({
    stepId: "apply-0065",
    readOnlyParts: {
      markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].done], "apply-0065": [MARKERS["apply-0065"].none, MARKERS["apply-0065"].none] },
    },
  });
  await assert.rejects(report, migrateStops("P3_POSTCHECK_FAILED"));
});

test("a 401/403 on the first file reports not_authorized with nothing applied", async () => {
  const { report } = run({
    stepId: "apply-0065",
    readOnlyParts: { markers: { "baseline-0001-0064": [MARKERS["baseline-0001-0064"].done], "apply-0065": [MARKERS["apply-0065"].none] } },
    respond: async () => ({ authorized: false, httpStatus: 403 }),
  });
  const r = await report;
  assert.equal(r.outcome, "not_authorized");
  assert.deepEqual(r.filesApplied, []);
});

test("an unknown step id is refused outright", async () => {
  const { report } = run({ stepId: "apply-9999" });
  await assert.rejects(report, migrateStops("P3_STEP_UNKNOWN"));
});

test("the CLI requires the step-specific phrase: a phrase authorizes exactly one step", () => {
  assert.throws(() => cli.parseMigrateCliArgs([]), guardStops("INVALID_ARGS"));
  assert.throws(() => cli.parseMigrateCliArgs(["--step=apply-9999", "--confirm-p3=x"]), guardStops("INVALID_ARGS"));
  assert.throws(() => cli.parseMigrateCliArgs(["--step=apply-0065", "--confirm-p3=nope"]), guardStops("CONFIRMATION_REQUIRED"));
  assert.throws(
    () => cli.parseMigrateCliArgs(["--step=apply-0066", `--confirm-p3=${cli.p3ConfirmationPhraseForStep("apply-0065")}`]),
    guardStops("CONFIRMATION_REQUIRED"),
    "one step's phrase does not unlock another step",
  );
  for (const stepId of check.CANARY_STEP_ORDER) {
    assert.equal(cli.parseMigrateCliArgs([`--step=${stepId}`, `--confirm-p3=${cli.p3ConfirmationPhraseForStep(stepId)}`]), stepId);
  }
});
