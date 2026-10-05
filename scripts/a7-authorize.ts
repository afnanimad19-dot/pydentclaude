// Pydent A7 authorization probe — CLI. OPERATOR-ONLY, READ-ONLY BY CONSTRUCTION.
//
// Usage (run explicitly by the operator on their own machine, with .env.a7):
//   npm run a7:authorize -- --confirm=<exact probe phrase>
//
// Purpose: the controlled FIRST CONTACT with the A7 validation database. It
// verifies the protected a7_guard.sentinel via authorizeA7Mutation() and
// reports eligibility — and does nothing else. It is structurally incapable
// of applying a migration:
//   * it accepts NO step id, NO SQL, NO refs/URLs/endpoints/filenames — the
//     only argument that exists is the probe confirmation phrase;
//   * it constructs createSentinelReadTransport, whose one capability is the
//     fixed read-only sentinel query (read_only: true is hard-coded);
//   * it never references runLiveStep, executeMutation, createLiveTransport,
//     the step manifest, or the migrations directory, and reads no SQL;
//   * it holds the PROBE confirmation phrase, not the mutation phrase, so the
//     mutation path would refuse it even if it were somehow reached.
//
// Output allowlist: PASS/FAIL, failure codes, the verified A7 ref. Never:
// tokens, digests, Authorization headers, env values.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  A7_AUTHORIZE_CONFIRMATION_PHRASE,
  ENV_A7_FILENAME,
  parseEnvA7,
  validateA7EnvConfig,
  runA7AuthorizationProbe,
  A7RunnerError,
} from "./a7-mutate-lib";
import { createSentinelReadTransport } from "./a7-live-transport";

export function parseAuthorizeCliArgs(argv: readonly string[]): { confirmation: string } {
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
    ({ confirmation } = parseAuthorizeCliArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof A7RunnerError ? e.message : "A7 RUNNER REFUSED [INVALID_ARGS]");
    console.error("usage: npm run a7:authorize -- --confirm=<exact probe phrase from scripts/a7-mutate-lib.ts>");
    return 1;
  }

  console.log("A7 authorization probe — READ-ONLY sentinel verification (no migrations, no writes)");

  try {
    if (!fs.existsSync(envA7Path)) throw new A7RunnerError("ENV_FILE_MISSING");
    const env = parseEnvA7(fs.readFileSync(envA7Path, "utf8"));
    validateA7EnvConfig(env); // production / wrong ref / wrong URL refused BEFORE any network

    const transport = createSentinelReadTransport(env);
    const result = await runA7AuthorizationProbe({
      confirmation,
      env,
      executeSentinelQuery: transport.executeSentinelQuery,
    });
    console.log(`AUTHORIZATION: ELIGIBLE — sentinel verified for A7 project ${result.ref}. No mutation was performed.`);
    return 0;
  } catch (e) {
    const msg =
      e instanceof A7RunnerError || (e instanceof Error && (e.name === "A7GuardError" || e.name === "A7SentinelGuardError"))
        ? e.message
        : `A7 RUNNER REFUSED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`;
    console.error(msg);
    console.error("AUTHORIZATION: FAILED CLOSED. No mutation was performed.");
    return 1;
  }
}

// Run only when invoked as the entry script — importing this module (tests do,
// to reach parseAuthorizeCliArgs) must never execute the probe.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
