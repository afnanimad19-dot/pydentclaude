// Pydent Phase 2B CANARY migration plan CLI — OFFLINE. EXECUTES NOTHING.
//
//   node --experimental-strip-types --import ./tests/alias-loader-register.mjs scripts/canary-plan.ts [--json]
//
// Verifies the complete hash-pinned manifest and prints the ordered,
// approval-gated plan. Imports no transport; performs no network I/O.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildCanaryExecutionPlan } from "./canary-plan-lib";
import { readMigrationDisk } from "./canary-manifest-check";
import { CanaryError } from "./canary-guard";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = path.join(repoRoot, "supabase", "migrations");

export function parsePlanCliArgs(argv: readonly string[]): { json: boolean } {
  if (argv.length === 0) return { json: false };
  if (argv.length === 1 && argv[0] === "--json") return { json: true };
  throw new CanaryError("INVALID_ARGS", "usage: canary-plan [--json]");
}

function main(): number {
  let json: boolean;
  try {
    ({ json } = parsePlanCliArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(e instanceof CanaryError ? e.message : "CANARY REFUSED [INVALID_ARGS]");
    return 1;
  }
  const plan = buildCanaryExecutionPlan({
    manifestSource: fs.readFileSync(path.join(repoRoot, "scripts", "a7-manifest.ts"), "utf8"),
    disk: readMigrationDisk(migrationsDir),
    readSql: (file) => fs.readFileSync(path.join(migrationsDir, file), "utf8"),
  });

  if (json) {
    console.log(JSON.stringify(plan, null, 2));
    return plan.ok ? 0 : 1;
  }

  console.log(`CANARY MIGRATION PLAN — target ${plan.target} — NOTHING IS EXECUTED`);
  for (const c of plan.manifest.checks) console.log(` ${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` [${c.detail}]` : ""}`);
  for (const p of plan.phases) {
    console.log(`\n${p.id} [${p.kind}] ${p.title}`);
    console.log(`   gate: ${p.approvalGate}`);
    for (const r of p.requests) {
      const flag = r.transactionScan.wrapSafe ? "tx-safe" : "TX-UNSAFE";
      console.log(`   ${String(r.order).padStart(2, " ")}. ${r.file}  ${r.sha256.slice(0, 12)}…  ${flag}${r.transactionScan.cautions.length ? `  caution: ${r.transactionScan.cautions.join("; ")}` : ""}`);
    }
    for (const c of p.postChecks) console.log(`   post-check: ${c}`);
    for (const n of p.notes) console.log(`   note: ${n}`);
  }
  console.log("\nRollback strategy:");
  for (const r of plan.rollback) console.log(` - ${r}`);
  if (plan.blockers.length > 0) {
    console.error("\nPLAN BLOCKERS:");
    for (const b of plan.blockers) console.error(` - ${b}`);
    return 1;
  }
  console.log(`\nPLAN OK: ${plan.phases.reduce((n, p) => n + p.requests.length, 0)} migration requests across ${plan.manifest.steps.length} manifest steps.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
