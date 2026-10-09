// Pydent Phase 2B CANARY functional validation (P9) CLI.
//
//   NODE_USE_ENV_PROXY=1 node --experimental-strip-types --import ./tests/alias-loader-register.mjs \
//     scripts/canary-validate.ts --confirm-p9=<CANARY_P9_CONFIRMATION_PHRASE>
//
// Order (each refuses before the next): exact P9 confirmation phrase; canary
// environment guard; sentinel authorization; migrated-state gate; residue
// preflight (REFUSES, never cleans); baseline counts; tests A-F over two
// temporary validation workspaces; finally exact-id-and-name cleanup with
// absence and baseline-restoration verification. Reads no .env file, sends no
// credential (the proxy injects the canary-scoped secret), never writes
// supabase_migrations, never touches canary_guard, never retries.

import { pathToFileURL } from "node:url";
import { CANARY_PROJECT_REF, CanaryError } from "./canary-guard";
import { createCanaryReadOnlyTransport } from "./canary-transport";
import { createCanaryWriteProbeTransport, CanaryProbeError } from "./canary-probe-lib";
import { CanaryValidateError, runCanary2bFunctionalValidation } from "./canary-validate-lib";

export const CANARY_P9_CONFIRMATION_PHRASE =
  "I-AUTHORIZE-P9-FUNCTIONAL-VALIDATION-WITH-TEMPORARY-DATA-ON-THE-CANARY-thqjtoxzkujnljsmkwkp";

export function parseValidateCliArgs(argv: readonly string[]): void {
  if (argv.length !== 1 || !argv[0].startsWith("--confirm-p9=")) throw new CanaryError("INVALID_ARGS");
  if (argv[0].slice("--confirm-p9=".length) !== CANARY_P9_CONFIRMATION_PHRASE) throw new CanaryError("CONFIRMATION_REQUIRED");
}

async function main(): Promise<number> {
  try {
    parseValidateCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CanaryError ? e.message : "CANARY REFUSED [INVALID_ARGS]");
    console.error("usage: canary-validate --confirm-p9=<exact phrase from scripts/canary-validate.ts>");
    return 1;
  }

  try {
    const readOnlyTransport = createCanaryReadOnlyTransport(process.env);
    const probeTransport = createCanaryWriteProbeTransport(process.env);
    console.log(`CANARY P9 FUNCTIONAL VALIDATION — target ${CANARY_PROJECT_REF} (temporary marker-named data; exact-id cleanup; sentinel-gated)`);
    const report = await runCanary2bFunctionalValidation({
      env: process.env,
      readOnly: readOnlyTransport.executeReadOnlyQuery,
      probe: probeTransport,
    });
    for (const c of report.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
    console.log(
      `run ids: w1 workspace=${report.runIds.w1.workspaceId} w2 workspace=${report.runIds.w2.workspaceId}` +
        ` cleanupOk=${report.cleanupOk}${report.cleanupDetail ? ` cleanupDetail=${report.cleanupDetail}` : ""}`,
    );
    if (report.ok) {
      console.log("CANARY P9: COMPLETE — all functional checks passed and cleanup verified. Run canary-preflight for the independent residue check.");
      return 0;
    }
    console.error("CANARY P9: FAILED — see the checks above. Any remaining run rows are listed by uuid; recovery needs separate approval.");
    return 1;
  } catch (e) {
    if (e instanceof CanaryValidateError || e instanceof CanaryProbeError || e instanceof CanaryError) console.error(e.message);
    else console.error(`CANARY P9: STOPPED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`);
    console.error("CANARY P9: STOPPED before or during the run. Nothing further was sent.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
