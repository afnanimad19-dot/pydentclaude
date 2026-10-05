// Pydent A7 mutation runner — CLI. OPERATOR-ONLY, DRY-RUN ONLY IN THIS BUILD.
//
// Usage (run explicitly by the operator, never by the app):
//   npm run a7:dry-run -- <step-id>
//   step-id: baseline-0001-0064 | apply-0065 | apply-0066
//
// This build performs VALIDATION ONLY: manifest + pinned SHA-256 hashes +
// ordering + closed-world directory check + sentinel-protection scan + local
// .env.a7 configuration. It performs ZERO HTTP requests and cannot mutate any
// database: there is no flag that selects live mode and the live transport
// factory throws unconditionally (see scripts/a7-mutate-lib.ts).
//
// Output is restricted to: step id, migration filenames, approved hashes,
// PASS/FAIL per check, and failure codes. Secrets and env values are never
// printed; .env.a7 content never leaves parseEnvA7/validateA7EnvConfig.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  A7_STEPS,
  ENV_A7_FILENAME,
  parseCliArgs,
  runDryRun,
  A7RunnerError,
  type DiskMigration,
} from "./a7-mutate-lib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");
const envA7Path = path.join(repoRoot, ENV_A7_FILENAME); // fixed path; never configurable

function readDisk(): DiskMigration[] {
  return fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      sha256: createHash("sha256").update(fs.readFileSync(path.join(migrationsDir, file))).digest("hex"),
    }));
}

const readSql = (file: string): string => {
  // Only manifest-validated basenames ever reach this point; refuse anything path-like.
  if (file.includes("/") || file.includes("\\") || file.includes("..")) throw new A7RunnerError("EXTRA_MIGRATION", file);
  return fs.readFileSync(path.join(migrationsDir, file), "utf8");
};

const readEnvFile = (): string | null => (fs.existsSync(envA7Path) ? fs.readFileSync(envA7Path, "utf8") : null);

function main(): number {
  let stepId;
  try {
    ({ stepId } = parseCliArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof A7RunnerError ? e.message : "A7 RUNNER REFUSED [INVALID_ARGS]");
    console.error(`known steps: ${Object.keys(A7_STEPS).join(", ")}`);
    return 1;
  }

  console.log(`A7 mutation runner — DRY RUN (live execution disabled in this build)`);
  console.log(`step: ${stepId} — ${A7_STEPS[stepId].description}`);
  console.log(`migrations in step: ${A7_STEPS[stepId].migrations.length}`);

  const report = runDryRun({ stepId, readDisk, readSql, readEnvFile });
  for (const check of report.checks) {
    console.log(` ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? ` [${check.detail}]` : ""}`);
  }
  console.log(report.ok ? "DRY RUN: ALL CHECKS PASSED (no HTTP performed, nothing mutated)" : "DRY RUN: FAILED CLOSED (no HTTP performed, nothing mutated)");
  return report.ok ? 0 : 1;
}

process.exit(main());
