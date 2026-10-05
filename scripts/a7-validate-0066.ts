// Pydent A7 — post-0066 READ-ONLY validation CLI. OPERATOR-ONLY.
//
// Usage (run explicitly by the operator, with .env.a7):
//   npm run a7:validate-0066 -- --confirm=<exact probe phrase>
//
// Read-only by construction: the only argument that exists is the read-only
// probe confirmation phrase (no step ids, SQL, refs, URLs, or endpoints); the
// only transports constructed are createSentinelReadTransport and
// createReadOnlyQueryTransport, neither of which has a mutation member and
// both of which hard-code read_only: true; the validation SQL is a fixed
// SELECT constant. Targeting is pinned to the A7 project ref; production is
// refused by checkA7Config BEFORE any network use; the sentinel is verified
// (authorizeA7Mutation, token digest handled by the existing guard — never
// printed) before the validation query runs.
//
// Output allowlist: PASS/FAIL per check, failure codes, the verified A7 ref.
// Never: tokens, digests, Authorization headers, env values, raw responses.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  A7_AUTHORIZE_CONFIRMATION_PHRASE,
  ENV_A7_FILENAME,
  parseEnvA7,
  validateA7EnvConfig,
  A7RunnerError,
} from "./a7-mutate-lib";
import { createSentinelReadTransport, createReadOnlyQueryTransport } from "./a7-live-transport";
import { runA7Post0066Validation } from "./a7-validate-0066-lib";

export function parseValidateCliArgs(argv: readonly string[]): { confirmation: string } {
  // Exactly one argument exists for this command: --confirm=<phrase>.
  if (argv.length !== 1 || !argv[0].startsWith("--confirm=")) throw new A7RunnerError("INVALID_ARGS");
  const confirmation = argv[0].slice("--confirm=".length);
  if (confirmation !== A7_AUTHORIZE_CONFIRMATION_PHRASE) {
    throw new A7RunnerError("AUTHORIZE_CONFIRMATION_REQUIRED");
  }
  return { confirmation };
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envA7Path = path.join(repoRoot, ENV_A7_FILENAME); // fixed path; never configurable

async function main(): Promise<number> {
  let confirmation: string;
  try {
    ({ confirmation } = parseValidateCliArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof A7RunnerError ? e.message : "A7 RUNNER REFUSED [INVALID_ARGS]");
    console.error("usage: npm run a7:validate-0066 -- --confirm=<exact probe phrase from scripts/a7-mutate-lib.ts>");
    return 1;
  }

  console.log("A7 post-0066 validation — READ-ONLY (no migrations, no writes)");

  try {
    if (!fs.existsSync(envA7Path)) throw new A7RunnerError("ENV_FILE_MISSING");
    const env = parseEnvA7(fs.readFileSync(envA7Path, "utf8"));
    validateA7EnvConfig(env); // production / wrong ref / wrong URL refused BEFORE any network

    const sentinel = createSentinelReadTransport(env);
    const reader = createReadOnlyQueryTransport(env);
    const result = await runA7Post0066Validation({
      confirmation,
      env,
      executeSentinelQuery: sentinel.executeSentinelQuery,
      executeReadOnlyQuery: reader.executeReadOnlyQuery,
    });
    for (const check of result.checks) console.log(` ${check.ok ? "PASS" : "FAIL"}  ${check.name}`);
    console.log(`POST-0066 VALIDATION: ALL CHECKS PASSED for A7 project ${result.ref}. No mutation was performed.`);
    return 0;
  } catch (e) {
    const msg =
      e instanceof A7RunnerError || (e instanceof Error && (e.name === "A7GuardError" || e.name === "A7SentinelGuardError"))
        ? e.message
        : `A7 RUNNER REFUSED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`;
    console.error(msg);
    console.error("POST-0066 VALIDATION: FAILED CLOSED. No mutation was performed.");
    return 1;
  }
}

// Run only when invoked as the entry script — importing this module (tests do,
// to reach parseValidateCliArgs) must never execute the validation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
