// Pydent Phase 2B CANARY migration step CLI — ONE STEP PER INVOCATION.
//
//   NODE_USE_ENV_PROXY=1 node --experimental-strip-types --import ./tests/alias-loader-register.mjs \
//     scripts/canary-migrate.ts --step=<stepId> --confirm-p3=<phrase for that step>
//
// The confirmation phrase EMBEDS the step id, so a phrase authorizes exactly
// one step: I-AUTHORIZE-P3-MIGRATION-STEP-<stepId>-ON-THE-CANARY-<ref>.
// Order (each refuses before the next): exact phrase for the named step;
// OFFLINE manifest checksum verification; canary environment guard; sentinel
// gate; P2-hardened ACL posture; order/state checks; then one request per
// pinned file via the manifest-hash-gated transport. Reads no .env file,
// sends no credential (the proxy injects the canary-scoped secret), never
// writes supabase_migrations, never retries, never drops or repairs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CANARY_PROJECT_REF, CanaryError } from "./canary-guard";
import { readMigrationDisk, CANARY_STEP_ORDER } from "./canary-manifest-check";
import { createCanaryReadOnlyTransport } from "./canary-transport";
import { createCanaryWriteProbeTransport } from "./canary-probe-lib";
import { CanaryMigrateError, runCanaryMigrationStep } from "./canary-migrate-lib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

export const p3ConfirmationPhraseForStep = (stepId: string): string =>
  `I-AUTHORIZE-P3-MIGRATION-STEP-${stepId}-ON-THE-CANARY-${CANARY_PROJECT_REF}`;

/** Exactly two args, in order: --step=<known step>, --confirm-p3=<that step's exact phrase>. */
export function parseMigrateCliArgs(argv: readonly string[]): string {
  if (argv.length !== 2 || !argv[0].startsWith("--step=") || !argv[1].startsWith("--confirm-p3=")) {
    throw new CanaryError("INVALID_ARGS");
  }
  const stepId = argv[0].slice("--step=".length);
  if (!(CANARY_STEP_ORDER as readonly string[]).includes(stepId)) throw new CanaryError("INVALID_ARGS", "unknown step");
  if (argv[1].slice("--confirm-p3=".length) !== p3ConfirmationPhraseForStep(stepId)) throw new CanaryError("CONFIRMATION_REQUIRED");
  return stepId;
}

async function main(): Promise<number> {
  let stepId: string;
  try {
    stepId = parseMigrateCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CanaryError ? e.message : "CANARY REFUSED [INVALID_ARGS]");
    console.error("usage: canary-migrate --step=<stepId> --confirm-p3=<exact phrase for that step>");
    console.error(`steps, in order: ${CANARY_STEP_ORDER.join(" -> ")}`);
    return 1;
  }

  try {
    const readOnlyTransport = createCanaryReadOnlyTransport(process.env);
    const probeTransport = createCanaryWriteProbeTransport(process.env);
    console.log(`CANARY P3 MIGRATION STEP ${stepId} — target ${CANARY_PROJECT_REF} (one request per pinned file; history never written)`);
    const report = await runCanaryMigrationStep({
      env: process.env,
      readOnly: readOnlyTransport.executeReadOnlyQuery,
      probe: probeTransport,
      stepId,
      manifestSource: fs.readFileSync(path.join(repoRoot, "scripts", "a7-manifest.ts"), "utf8"),
      disk: readMigrationDisk(migrationsDir),
      readSql: (file) => fs.readFileSync(path.join(migrationsDir, file), "utf8"),
    });
    for (const c of report.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
    console.log(`outcome=${report.outcome} filesApplied=${report.filesApplied.length}${report.failedAtFile ? ` failedAt=${report.failedAtFile}` : ""}`);
    if (report.outcome === "step_applied") {
      console.log(`CANARY P3: step ${stepId} COMPLETE and verified. Run canary-preflight for the independent confirmation.`);
      return 0;
    }
    if (report.failureDetail) console.error(report.failureDetail);
    console.error(`CANARY P3: STOPPED with outcome ${report.outcome}. No retry was attempted; see the state capture above.`);
    return 1;
  } catch (e) {
    if (e instanceof CanaryMigrateError || e instanceof CanaryError) console.error(e.message);
    else console.error(`CANARY P3: STOPPED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`);
    console.error("CANARY P3: STOPPED. Nothing further was sent.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
