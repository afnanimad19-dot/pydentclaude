// Pydent Phase 2B CANARY migration checksum verification. NETWORK-FREE.
//
// Verifies the COMPLETE 68-file manifest before any canary step could run:
//   1. scripts/a7-manifest.ts is byte-for-byte the reviewed file (its SHA-256
//      is pinned here), so no step definition or pinned hash can change
//      without a reviewed update to this constant;
//   2. the manifest's step order is exactly the reviewed dependency order;
//   3. every step passes the UNCHANGED A7 closed-world validation
//      (validateStepManifest: hashes, ascending order, ranges, duplicate
//      prefixes, missing or stray .sql files);
//   4. the steps together cover every on-disk migration exactly once;
//   5. no migration references a guard schema (a7_guard or canary_guard).
//
// The A7 manifest and validator are imported, never modified.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { A7_STEPS, type A7StepId } from "./a7-manifest";
import { validateStepManifest, A7RunnerError, type DiskMigration } from "./a7-mutate-lib";
import { CanaryError } from "./canary-guard";

/** SHA-256 of scripts/a7-manifest.ts as reviewed at commit c394c238fe9a6d235d9b905fb57f6f613e699cd5. */
export const REVIEWED_MANIFEST_SOURCE_SHA256 = "7b3e21c0f9c15bbb18e259a22d2390d2492cb665c3e1ab734a8aa49f3071f975";

/** The reviewed dependency order (0067 before 0066: 0067 depends only on 0065; 0068 needs 0065 + 0067). */
export const CANARY_STEP_ORDER: readonly A7StepId[] = [
  "baseline-0001-0064",
  "apply-0065",
  "apply-0067",
  "apply-0066",
  "apply-0068",
] as const;

export const EXPECTED_MIGRATION_COUNT = 68;

export const sha256Hex = (content: string | Buffer): string => createHash("sha256").update(content).digest("hex");

/** Complete listing of <dir>/*.sql with SHA-256 of the exact bytes. */
export function readMigrationDisk(dir: string): DiskMigration[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sha256: sha256Hex(fs.readFileSync(path.join(dir, file))) }));
}

export type ManifestCheck = { readonly name: string; readonly ok: boolean; readonly detail?: string };

export type VerifiedStep = {
  readonly stepId: A7StepId;
  readonly migrations: readonly { readonly file: string; readonly sha256: string }[];
};

export type CanaryManifestReport = {
  readonly ok: boolean;
  readonly checks: readonly ManifestCheck[];
  /** Populated only when ok: steps in execution order with their verified files. */
  readonly steps: readonly VerifiedStep[];
};

const GUARD_SCHEMA_RE = /\b(a7_guard|canary_guard)\b/i;

/**
 * Verify everything. Never throws for a verification failure; returns a
 * report whose `ok` is false and whose checks name the failure. Throws only
 * on programming errors (e.g. readSql failing for a file it was told exists).
 */
export function verifyCanaryManifest(input: {
  readonly manifestSource: string;
  readonly disk: readonly DiskMigration[];
  readonly readSql: (file: string) => string;
}): CanaryManifestReport {
  const checks: ManifestCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  const sourceHash = sha256Hex(input.manifestSource);
  add("manifest source is the reviewed hash-pinned file", sourceHash === REVIEWED_MANIFEST_SOURCE_SHA256);

  const actualOrder = Object.keys(A7_STEPS);
  add(
    "manifest step order is the reviewed dependency order",
    JSON.stringify(actualOrder) === JSON.stringify(CANARY_STEP_ORDER),
    actualOrder.join(" -> "),
  );

  const steps: VerifiedStep[] = [];
  for (const stepId of CANARY_STEP_ORDER) {
    try {
      const migrations = validateStepManifest(stepId, input.disk);
      steps.push({ stepId, migrations: migrations.map((m) => ({ file: m.file, sha256: m.sha256 })) });
      add(`step ${stepId}: hashes, order and closed world verified`, true, `${migrations.length} file(s)`);
    } catch (e) {
      add(`step ${stepId}: hashes, order and closed world verified`, false, e instanceof A7RunnerError ? `${e.code}${e.detail ? `: ${e.detail}` : ""}` : "UNEXPECTED_ERROR");
    }
  }

  const covered = steps.flatMap((s) => s.migrations.map((m) => m.file));
  const unique = new Set(covered);
  add(
    `steps cover all ${EXPECTED_MIGRATION_COUNT} migrations exactly once`,
    covered.length === EXPECTED_MIGRATION_COUNT && unique.size === covered.length && input.disk.length === EXPECTED_MIGRATION_COUNT,
    `covered=${covered.length} unique=${unique.size} disk=${input.disk.length}`,
  );

  const guardHits = input.disk.filter((d) => GUARD_SCHEMA_RE.test(input.readSql(d.file))).map((d) => d.file);
  add("no migration references a guard schema (a7_guard / canary_guard)", guardHits.length === 0, guardHits.join(", ") || undefined);

  const ok = checks.every((c) => c.ok);
  return { ok, checks, steps: ok ? steps : [] };
}

/** Throwing wrapper for CLIs: the first failing check becomes a CanaryError. */
export function assertCanaryManifest(report: CanaryManifestReport): void {
  if (report.ok) return;
  const first = report.checks.find((c) => !c.ok)!;
  const code = first.name.startsWith("manifest source")
    ? "MANIFEST_SOURCE_CHANGED"
    : first.name.startsWith("manifest step order")
      ? "MANIFEST_STEP_ORDER"
      : first.name.startsWith("no migration references")
        ? "GUARD_SCHEMA_REFERENCED"
        : "MANIFEST_INVALID";
  throw new CanaryError(code, `${first.name}${first.detail ? `: ${first.detail}` : ""}`);
}
