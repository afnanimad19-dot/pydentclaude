// Pydent Phase 2B CANARY write-capability probe CLI — W1/W2, and W3 behind
// its own phrase (a live W3 run is a separate operator approval).
//
//   NODE_USE_ENV_PROXY=1 node --experimental-strip-types --import ./tests/alias-loader-register.mjs \
//     scripts/canary-probe.ts --confirm=<CANARY_PROBE_CONFIRMATION_PHRASE>      # W1/W2
//     scripts/canary-probe.ts --confirm-w3=<CANARY_W3_CONFIRMATION_PHRASE>      # W3
//     scripts/canary-probe.ts --confirm-p1=<CANARY_P1_CONFIRMATION_PHRASE>      # P1 (CANARY_SENTINEL_TOKEN in env)
//     scripts/canary-probe.ts --confirm-p2=<CANARY_P2_CONFIRMATION_PHRASE>      # P2 (sentinel-gated)
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
import {
  CanaryProbeError,
  PROPOSED_W3_CLEANUP_SQL,
  createCanaryWriteProbeTransport,
  runCanaryP1SentinelSetup,
  runCanaryP2Hardening,
  runCanaryW3Probe,
  runCanaryWriteProbe,
} from "./canary-probe-lib";

export const CANARY_PROBE_CONFIRMATION_PHRASE =
  "I-AUTHORIZE-THE-TWO-APPROVED-W1-W2-WRITE-CAPABLE-PROBES-AGAINST-THE-CANARY-thqjtoxzkujnljsmkwkp";

/** W3 has its own phrase: a live W3 run is a separate operator approval. */
export const CANARY_W3_CONFIRMATION_PHRASE =
  "I-AUTHORIZE-THE-W3-FAILURE-ATOMICITY-PROBE-AGAINST-THE-CANARY-thqjtoxzkujnljsmkwkp";

/** P1 has its own phrase: creating the sentinel is a separate operator approval. */
export const CANARY_P1_CONFIRMATION_PHRASE =
  "I-AUTHORIZE-P1-SENTINEL-CREATION-ON-THE-CANARY-thqjtoxzkujnljsmkwkp";

/** P2 has its own phrase: hardening the default privileges is a separate operator approval. */
export const CANARY_P2_CONFIRMATION_PHRASE =
  "I-AUTHORIZE-P2-PRIVILEGE-HARDENING-ON-THE-CANARY-thqjtoxzkujnljsmkwkp";

export type ProbeCliMode = "w1w2" | "w3" | "p1" | "p2";

export function parseProbeCliArgs(argv: readonly string[]): ProbeCliMode {
  if (argv.length !== 1) throw new CanaryError("INVALID_ARGS");
  if (argv[0].startsWith("--confirm=")) {
    if (argv[0].slice("--confirm=".length) !== CANARY_PROBE_CONFIRMATION_PHRASE) throw new CanaryError("CONFIRMATION_REQUIRED");
    return "w1w2";
  }
  if (argv[0].startsWith("--confirm-w3=")) {
    if (argv[0].slice("--confirm-w3=".length) !== CANARY_W3_CONFIRMATION_PHRASE) throw new CanaryError("CONFIRMATION_REQUIRED");
    return "w3";
  }
  if (argv[0].startsWith("--confirm-p1=")) {
    if (argv[0].slice("--confirm-p1=".length) !== CANARY_P1_CONFIRMATION_PHRASE) throw new CanaryError("CONFIRMATION_REQUIRED");
    return "p1";
  }
  if (argv[0].startsWith("--confirm-p2=")) {
    if (argv[0].slice("--confirm-p2=".length) !== CANARY_P2_CONFIRMATION_PHRASE) throw new CanaryError("CONFIRMATION_REQUIRED");
    return "p2";
  }
  throw new CanaryError("INVALID_ARGS");
}

async function main(): Promise<number> {
  let mode: ProbeCliMode;
  try {
    mode = parseProbeCliArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof CanaryError ? e.message : "CANARY REFUSED [INVALID_ARGS]");
    console.error("usage: canary-probe --confirm=<W1/W2 phrase> | --confirm-w3=<W3 phrase> (see scripts/canary-probe.ts)");
    return 1;
  }

  try {
    const readOnlyTransport = createCanaryReadOnlyTransport(process.env);
    const probeTransport = createCanaryWriteProbeTransport(process.env);

    if (mode === "p2") {
      console.log(`CANARY P2 PRIVILEGE HARDENING — target ${CANARY_PROJECT_REF} (one reviewed request; sentinel-gated; ACL posture verified before and after)`);
      const report = await runCanaryP2Hardening({
        env: process.env,
        readOnly: readOnlyTransport.executeReadOnlyQuery,
        probe: probeTransport,
      });
      for (const c of report.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
      if (report.outcome === "hardened") {
        console.log("CANARY P2: COMPLETE — defaults hardened and verified. Run canary-preflight for the independent confirmation.");
        return 0;
      }
      console.error(`CANARY P2: STOPPED with outcome ${report.outcome}. No further request was sent.`);
      return 1;
    }

    if (mode === "p1") {
      console.log(`CANARY P1 SENTINEL SETUP — target ${CANARY_PROJECT_REF} (two reviewed requests; token read from env only; nothing is printed from it)`);
      const report = await runCanaryP1SentinelSetup({
        env: process.env,
        readOnly: readOnlyTransport.executeReadOnlyQuery,
        probe: probeTransport,
      });
      for (const c of report.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
      if (report.outcome === "sentinel_created") {
        console.log("CANARY P1: COMPLETE — sentinel created and verified; public schema untouched.");
        return 0;
      }
      console.error(`CANARY P1: STOPPED with outcome ${report.outcome}. No further request was sent.`);
      return 1;
    }

    if (mode === "w3") {
      console.log(`CANARY W3 FAILURE-ATOMICITY PROBE — target ${CANARY_PROJECT_REF} (one deliberately failing request; frozen SQL)`);
      const report = await runCanaryW3Probe({
        env: process.env,
        readOnly: readOnlyTransport.executeReadOnlyQuery,
        probe: probeTransport,
      });
      for (const c of report.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
      console.log(`outcome=${report.outcome} atomicRollback=${String(report.atomicRollback)} cleanupRequired=${report.cleanupRequired}`);
      if (report.cleanupRequired) {
        console.log("W3 CLEANUP IS NOT EXECUTED BY THIS TOOL. Proposed cleanup for separate review/approval:");
        console.log(`  ${PROPOSED_W3_CLEANUP_SQL}`);
      }
      if (report.outcome === "atomic_rollback_confirmed") {
        console.log("CANARY W3: COMPLETE — failed request rolled back atomically; canary unchanged.");
        return 0;
      }
      console.error(`CANARY W3: STOPPED with outcome ${report.outcome}. No further request was sent.`);
      return 1;
    }

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
