// Pydent Phase 2B CANARY write-capability probe CLI — W1/W2 ONLY.
//
//   NODE_USE_ENV_PROXY=1 node --experimental-strip-types --import ./tests/alias-loader-register.mjs \
//     scripts/canary-probe.ts --confirm=<CANARY_PROBE_CONFIRMATION_PHRASE>
//
// Order (each step refuses before the next):
//   1. exact confirmation phrase for the two approved write-capable requests;
//   2. canary environment guard (production / A7 refs, A7_MODE, local
//      Supabase credentials, proxy) — before any network;
//   3. read-only blank baseline -> W1 -> gates -> W2 -> read-only verification.
// Reads no .env file. Sends only a Content-Type header (the proxy injects the
// canary-scoped secret). Output: check names, PASS/FAIL/STOP and counts only.

import { pathToFileURL } from "node:url";
import { CANARY_PROJECT_REF, CanaryError } from "./canary-guard";
import { createCanaryReadOnlyTransport } from "./canary-transport";
import { CanaryProbeError, createCanaryWriteProbeTransport, runCanaryWriteProbe } from "./canary-probe-lib";

export const CANARY_PROBE_CONFIRMATION_PHRASE =
  "I-AUTHORIZE-THE-TWO-APPROVED-W1-W2-WRITE-CAPABLE-PROBES-AGAINST-THE-CANARY-thqjtoxzkujnljsmkwkp";

export function parseProbeCliArgs(argv: readonly string[]): void {
  if (argv.length !== 1 || !argv[0].startsWith("--confirm=")) throw new CanaryError("INVALID_ARGS");
  if (argv[0].slice("--confirm=".length) !== CANARY_PROBE_CONFIRMATION_PHRASE) throw new CanaryError("CONFIRMATION_REQUIRED");
}

async function main(): Promise<number> {
  try {
    parseProbeCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CanaryError ? e.message : "CANARY REFUSED [INVALID_ARGS]");
    console.error("usage: canary-probe --confirm=<exact phrase from scripts/canary-probe.ts>");
    return 1;
  }

  try {
    const readOnlyTransport = createCanaryReadOnlyTransport(process.env);
    const probeTransport = createCanaryWriteProbeTransport(process.env);
    console.log(
      `CANARY WRITE-CAPABILITY PROBE — target ${CANARY_PROJECT_REF} (W1/W2 only; frozen SQL; temp-and-rollback only)`,
    );
    const report = await runCanaryWriteProbe({
      env: process.env,
      readOnly: readOnlyTransport.executeReadOnlyQuery,
      probe: probeTransport,
    });
    for (const c of report.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
    if (report.w1 && !report.w1.authorized) {
      console.log("CANARY PROBE: COMPLETE — write path NOT authorized for the injected credential; W2 was not attempted.");
      return 0;
    }
    console.log("CANARY PROBE: COMPLETE — W1 and W2 passed; read-only verification confirms the canary is unchanged.");
    return 0;
  } catch (e) {
    if (e instanceof CanaryProbeError || e instanceof CanaryError) console.error(e.message);
    else console.error(`CANARY PROBE STOPPED [UNEXPECTED_ERROR]: ${e instanceof Error ? e.name : "unknown"}`);
    console.error("CANARY PROBE: STOPPED at the failing step. See the message above; no further request was sent.");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  });
}
