// Pydent Phase 2B CANARY read-only preflight CLI.
//
//   NODE_USE_ENV_PROXY=1 node --experimental-strip-types --import ./tests/alias-loader-register.mjs \
//     scripts/canary-preflight.ts --confirm=<CANARY_PREFLIGHT_CONFIRMATION_PHRASE>
//
// Order (each step refuses before the next):
//   1. exact read-only confirmation phrase;
//   2. OFFLINE manifest checksum verification (no network unless it passes);
//   3. canary environment guard (production / A7 refs, A7_MODE, local
//      Supabase credentials, proxy) — before any network;
//   4. read-only preflight through the read-only transport.
// Reads no .env file. Sends no Authorization header (the proxy injects the
// canary-scoped secret). Output: check names, PASS/FAIL and counts only.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CanaryError, CANARY_PROJECT_REF } from "./canary-guard";
import { assertCanaryManifest, readMigrationDisk, verifyCanaryManifest } from "./canary-manifest-check";
import { createCanaryReadOnlyTransport } from "./canary-transport";
import { CANARY_PREFLIGHT_CONFIRMATION_PHRASE, runCanaryPreflight } from "./canary-preflight-lib";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

export function parsePreflightCliArgs(argv: readonly string[]): void {
  if (argv.length !== 1 || !argv[0].startsWith("--confirm=")) throw new CanaryError("INVALID_ARGS");
  if (argv[0].slice("--confirm=".length) !== CANARY_PREFLIGHT_CONFIRMATION_PHRASE) throw new CanaryError("CONFIRMATION_REQUIRED");
}

async function main(): Promise<number> {
  try {
    parsePreflightCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CanaryError ? e.message : "CANARY REFUSED [INVALID_ARGS]");
    console.error("usage: canary-preflight --confirm=<exact phrase from scripts/canary-preflight-lib.ts>");
    return 1;
  }

  try {
    const manifest = verifyCanaryManifest({
      manifestSource: fs.readFileSync(path.join(repoRoot, "scripts", "a7-manifest.ts"), "utf8"),
      disk: readMigrationDisk(migrationsDir),
      readSql: (file) => fs.readFileSync(path.join(migrationsDir, file), "utf8"),
    });
    for (const c of manifest.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  manifest: ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
    assertCanaryManifest(manifest);

    const transport = createCanaryReadOnlyTransport(process.env);
    console.log(`CANARY READ-ONLY PREFLIGHT — target ${CANARY_PROJECT_REF} (read_only: true; no writes possible through this transport)`);
    const report = await runCanaryPreflight({ env: process.env, executeReadOnlyQuery: transport.executeReadOnlyQuery });
    for (const c of report.checks) {
      console.log(` ${c.ok ? "PASS" : "FAIL"}  [${c.kind}] ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
    }
    console.log(`state=${report.state} completedThrough=${report.completedThrough ?? "none"} passed=${report.passed} readyForWrites=${report.readyForWrites}`);
    if (!report.passed) {
      console.error("CANARY PREFLIGHT: FAILED (required check). Nothing was written.");
      return 1;
    }
    console.log(
      report.readyForWrites
        ? "CANARY PREFLIGHT: PASSED; write preconditions hold."
        : "CANARY PREFLIGHT: PASSED; write steps remain BLOCKED by the readiness checks above.",
    );
    return 0;
  } catch (e) {
    console.error(e instanceof CanaryError ? e.message : `CANARY REFUSED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`);
    console.error("CANARY PREFLIGHT: STOPPED. Nothing was written.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
