// Pydent A7 mutation runner — LIVE CLI. OPERATOR-ONLY, DELIBERATE-USE-ONLY.
//
// Usage (run explicitly by the operator on their own machine, with .env.a7):
//   npm run a7:live -- <step-id> --confirm=<exact confirmation phrase>
//   step-id: baseline-0001-0064 | apply-0065 | apply-0066
//
// This command MUTATES the isolated A7 validation database. It refuses unless
// ALL of the following hold, in this order:
//   1. argv is exactly one allowlisted step id plus the EXACT confirmation
//      phrase (no --sql/--query/stdin/paths/refs/URLs are accepted — there is
//      no way to supply SQL or a target through this command);
//   2. .env.a7 exists at the repo root, parses strictly, and passes the full
//      A7 identity guard (production ref anywhere in it refuses);
//   3. the step's manifest, pinned SHA-256 hashes, ordering, closed-world
//      directory check, and a7_guard sentinel-protection scan all pass;
//   4. checkA7Config passes again inside runLiveStep (production first);
//   5. authorizeA7Mutation verifies the live sentinel immediately before the
//      first mutation request.
// One invocation applies exactly ONE step; steps are never chained. The first
// failing migration stops the sequence; later files are not attempted.
//
// Output allowlist: step id, filenames, counts, PASS/FAIL, safe (scrubbed)
// HTTP statuses. Never: tokens, digests, Authorization headers, env values.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  A7_STEPS,
  A7_LIVE_CONFIRMATION_PHRASE,
  ENV_A7_FILENAME,
  parseEnvA7,
  validateA7EnvConfig,
  runLiveStep,
  A7RunnerError,
  type A7StepId,
  type DiskMigration,
} from "./a7-mutate-lib";
import { createLiveTransport } from "./a7-live-transport";

export function parseLiveCliArgs(argv: readonly string[]): { stepId: A7StepId; confirmation: string } {
  let stepId: string | null = null;
  let confirmation: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith("--confirm=")) {
      if (confirmation !== null) throw new A7RunnerError("INVALID_ARGS");
      confirmation = arg.slice("--confirm=".length);
      continue;
    }
    if (arg.startsWith("-")) throw new A7RunnerError("INVALID_ARGS"); // no other flags exist
    if (stepId !== null) throw new A7RunnerError("INVALID_ARGS");
    stepId = arg;
  }
  if (stepId === null) throw new A7RunnerError("INVALID_ARGS");
  if (!Object.prototype.hasOwnProperty.call(A7_STEPS, stepId)) {
    throw new A7RunnerError("UNKNOWN_STEP", stepId.slice(0, 64));
  }
  if (confirmation !== A7_LIVE_CONFIRMATION_PHRASE) {
    throw new A7RunnerError("LIVE_CONFIRMATION_REQUIRED");
  }
  return { stepId: stepId as A7StepId, confirmation };
}

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
  if (file.includes("/") || file.includes("\\") || file.includes("..")) throw new A7RunnerError("EXTRA_MIGRATION", file);
  return fs.readFileSync(path.join(migrationsDir, file), "utf8");
};

async function main(): Promise<number> {
  let stepId: A7StepId, confirmation: string;
  try {
    ({ stepId, confirmation } = parseLiveCliArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof A7RunnerError ? e.message : "A7 RUNNER REFUSED [INVALID_ARGS]");
    console.error("usage: npm run a7:live -- <step-id> --confirm=<exact phrase from scripts/a7-mutate-lib.ts>");
    return 1;
  }

  console.log(`A7 mutation runner — LIVE (isolated A7 validation database only)`);
  console.log(`step: ${stepId} — ${A7_STEPS[stepId].description}`);

  try {
    // Local secrets: .env.a7 only, parsed strictly, guard-validated. Values
    // never leave the env object; nothing below logs any of them.
    if (!fs.existsSync(envA7Path)) throw new A7RunnerError("ENV_FILE_MISSING");
    const env = parseEnvA7(fs.readFileSync(envA7Path, "utf8"));
    validateA7EnvConfig(env);

    const transport = createLiveTransport(env);
    const result = await runLiveStep({
      confirmation,
      stepId,
      env,
      readDisk,
      readSql,
      executeSentinelQuery: transport.executeSentinelQuery,
      executeMutation: async (sql, file, auth) => {
        await transport.executeMutation(sql, file, auth);
        console.log(` APPLIED  ${file}`);
      },
    });
    console.log(`LIVE STEP COMPLETE: ${result.applied.length} migration(s) applied in manifest order.`);
    return 0;
  } catch (e) {
    // Guard/runner errors carry fixed, secret-free messages; anything else is
    // reduced to its constructor name so no foreign error can leak material.
    const msg =
      e instanceof A7RunnerError || (e instanceof Error && (e.name === "A7GuardError" || e.name === "A7SentinelGuardError"))
        ? e.message
        : `A7 RUNNER REFUSED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`;
    console.error(msg);
    console.error("LIVE STEP FAILED CLOSED: stopped at the first failure; later migrations were not attempted.");
    return 1;
  }
}

// Run only when invoked as the entry script — importing this module (tests do,
// to reach parseLiveCliArgs) must never execute the live flow.
//
// process.exitCode (not process.exit): a forced exit races libuv handle
// teardown (undici keep-alive socket + --import loader thread) and asserts on
// Windows (src\win\async.c:94). Draining exits promptly with the same code.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
