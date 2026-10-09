// Pydent A7 — Phase 2B FUNCTIONAL validation CLI. OPERATOR-ONLY. MUTATES A7
// (temporary validation-owned rows only), so it requires its OWN confirmation
// phrase — the read-only probe phrase and the migration-apply phrase are both
// refused.
//
// Usage (run explicitly by the operator, with .env.a7):
//   npm run a7:validate-2b -- --confirm=<exact Phase 2B validation phrase>
//
// What it does (scripts/a7-validate-2b-lib.ts): confirmation → A7 identity
// guard (production refused BEFORE any network) → sentinel authorization →
// read-only residue preflight (marker residue REFUSES the run; nothing is ever
// cleaned up here) → baseline counts → create 1 temporary workspace/resource/
// document → TESTS A–D against the real knowledge_reindex_document → cleanup
// of exactly the current run's workspace (id + exact name; cascades) →
// absence + baseline-restoration verification. Every runtime value travels as
// a bound parameter; migrations are never run; knowledge_match_chunks is
// never called; no historical/backfill behavior exists.
//
// Output allowlist: PASS/FAIL per check, failure codes, the verified A7 ref,
// and the current run's validation UUIDs. Never: tokens, digests,
// Authorization headers, env values, raw responses, document content.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  A7_2B_VALIDATION_CONFIRMATION_PHRASE,
  ENV_A7_FILENAME,
  parseEnvA7,
  validateA7EnvConfig,
  A7RunnerError,
} from "./a7-mutate-lib";
import { createFunctionalValidationTransport } from "./a7-live-transport";
import { runA72bFunctionalValidation } from "./a7-validate-2b-lib";

export function parseValidate2bCliArgs(argv: readonly string[]): { confirmation: string } {
  // Exactly one argument exists for this command: --confirm=<phrase>.
  if (argv.length !== 1 || !argv[0].startsWith("--confirm=")) throw new A7RunnerError("INVALID_ARGS");
  const confirmation = argv[0].slice("--confirm=".length);
  if (confirmation !== A7_2B_VALIDATION_CONFIRMATION_PHRASE) {
    throw new A7RunnerError("VALIDATION_2B_CONFIRMATION_REQUIRED");
  }
  return { confirmation };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envA7Path = path.join(repoRoot, ENV_A7_FILENAME); // fixed path; never configurable

async function main(): Promise<number> {
  let confirmation: string;
  try {
    ({ confirmation } = parseValidate2bCliArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof A7RunnerError ? e.message : "A7 RUNNER REFUSED [INVALID_ARGS]");
    console.error("usage: npm run a7:validate-2b -- --confirm=<exact Phase 2B validation phrase from scripts/a7-mutate-lib.ts>");
    return 1;
  }

  console.log("A7 Phase 2B functional validation — CREATES AND DELETES TEMPORARY VALIDATION DATA in the A7 project only (no migrations, no production, no unrelated rows).");

  try {
    if (!fs.existsSync(envA7Path)) throw new A7RunnerError("ENV_FILE_MISSING");
    const env = parseEnvA7(fs.readFileSync(envA7Path, "utf8"));
    validateA7EnvConfig(env); // production / wrong ref / wrong URL refused BEFORE any network

    const transport = createFunctionalValidationTransport(env);
    const report = await runA72bFunctionalValidation({
      confirmation,
      env,
      executeSentinelQuery: transport.executeSentinelQuery,
      executeReadOnlyQuery: transport.executeReadOnlyQuery,
      executeParameterizedMutation: transport.executeParameterizedMutation,
    });

    for (const check of report.checks) console.log(` ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? ` [${check.detail}]` : ""}`);

    if (!report.cleanupOk) {
      console.error("A7 VALIDATION CLEANUP FAILED");
      console.error(` validation workspace: ${report.runIds.workspaceId}`);
      console.error(` validation resource:  ${report.runIds.resourceId}`);
      console.error(` validation document:  ${report.runIds.documentId ?? "(none created)"}`);
      if (report.cleanupDetail) console.error(` detail: ${report.cleanupDetail}`);
      console.error("No broader cleanup was attempted; recovery requires its own operator gate.");
      return 1;
    }
    if (!report.ok) {
      console.error(`PHASE 2B FUNCTIONAL VALIDATION: FAILED CLOSED for A7 project ${report.ref}. Temporary validation data was removed and the baseline verified.`);
      return 1;
    }
    console.log(`PHASE 2B FUNCTIONAL VALIDATION: ALL CHECKS PASSED for A7 project ${report.ref}. All temporary validation data removed; baseline restored.`);
    return 0;
  } catch (e) {
    const msg =
      e instanceof A7RunnerError || (e instanceof Error && (e.name === "A7GuardError" || e.name === "A7SentinelGuardError"))
        ? e.message
        : `A7 RUNNER REFUSED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`;
    console.error(msg);
    console.error("PHASE 2B FUNCTIONAL VALIDATION: REFUSED BEFORE MUTATION. Nothing was created or deleted.");
    return 1;
  }
}

// Run only when invoked as the entry script — importing this module (tests do,
// to reach parseValidate2bCliArgs) must never execute the validation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
