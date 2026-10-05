// Pydent A7 mutation runner — library. OPERATOR/TOOLING ONLY, FAILS CLOSED.
//
// Never imported by the Next.js application or client code: this file lives
// outside src/ and nothing in the app runtime references scripts/. It is
// consumed only by the a7-mutate CLI (run explicitly by the operator) and by
// the test suite (with mocks).
//
// *** THIS MODULE IS NETWORK-FREE. ***
// The dry-run CLI (scripts/a7-mutate.ts) uses only this module and can never
// perform HTTP. The real transport lives solely in scripts/a7-live-transport.ts
// and is wired in only by the separate operator live CLI
// (scripts/a7-mutate-live.ts), which additionally requires the exact
// A7_LIVE_CONFIRMATION_PHRASE — runLiveStep refuses without it.
//
// Structural execution order for the live path, enforced by runLiveStep and
// covered by tests:
//   exact live confirmation phrase (refused otherwise)
//   -> validate manifest + hashes + order + closed world + sentinel protection
//   -> checkA7Config (production blocking first; identity must pass)
//   -> authorizeA7Mutation (live sentinel check, immediately before mutation)
//   -> execute exactly ONE approved step's migrations, in manifest order
//   -> exit.
// The authorization value is function-local: nothing caches or reuses it, and
// a later mutation is a new process invocation that re-authorizes.
//
// Secrets: the operator-local .env.a7 (git-ignored via the existing `.env*`
// rule) is the ONLY source for A7_SENTINEL_TOKEN and A7_SUPABASE_MGMT_TOKEN.
// There is deliberately no fallback to process.env, .env, .env.local, Netlify
// or cloud environment configuration for these keys. No secret value is ever
// placed in an error message, log line, or report: errors carry fixed messages
// plus, at most, a key name, step id, or migration filename.

import {
  A7_PROJECT_REF,
  FORBIDDEN_PRODUCTION_REF,
  checkA7Config,
  A7GuardError,
} from "@/lib/a7-guard";
import {
  authorizeA7Mutation,
  type A7MutationAuthorization,
  type SentinelQueryExecutor,
} from "@/lib/a7-sentinel-guard";
import { A7_STEPS, type A7StepId, type A7ManifestEntry } from "./a7-manifest";

export { A7_STEPS };
export type { A7StepId };

/**
 * The exact confirmation the operator must supply to the SEPARATE live command
 * (`npm run a7:live -- <step> --confirm=<phrase>`) before any mutation can run.
 * Deliberately long, target-naming, and impossible to produce by accident from
 * normal arguments. It is NOT a secret — the gate is deliberateness, not
 * secrecy (secrecy lives in .env.a7). runLiveStep refuses without it, so even
 * programmatic callers cannot mutate unconfirmed.
 */
export const A7_LIVE_CONFIRMATION_PHRASE =
  "I-UNDERSTAND-THIS-MUTATES-THE-A7-VALIDATION-DATABASE-etbuylimyelwoxxowtbx";

/**
 * The exact confirmation the operator must supply to the AUTHORIZATION PROBE
 * (`npm run a7:authorize -- --confirm=<phrase>`), which contacts the A7
 * endpoint read-only and performs no mutation. Deliberately DISTINCT from the
 * mutation phrase above, so holding one can never satisfy the other gate.
 * Non-secret; exact, case-sensitive match required; no interactive prompt.
 */
export const A7_AUTHORIZE_CONFIRMATION_PHRASE =
  "I-UNDERSTAND-THIS-CONTACTS-THE-A7-VALIDATION-DATABASE-etbuylimyelwoxxowtbx";

/** The one endpoint a live executor may ever target — pinned to the A7 ref constant. */
export const A7_QUERY_ENDPOINT = `https://api.supabase.com/v1/projects/${A7_PROJECT_REF}/database/query`;

/** The only file secrets may come from, resolved against the repo root by the CLI. */
export const ENV_A7_FILENAME = ".env.a7";

/** The only keys .env.a7 may contain. Anything else fails closed (typo defense). */
export const ENV_A7_ALLOWED_KEYS = [
  "A7_MODE",
  "A7_EXPECTED_REF",
  "NEXT_PUBLIC_SUPABASE_URL",
  "A7_SENTINEL_TOKEN",
  "A7_SUPABASE_MGMT_TOKEN",
] as const;

export type A7RunnerFailureCode =
  | "INVALID_ARGS"
  | "UNKNOWN_STEP"
  | "LIVE_CONFIRMATION_REQUIRED"
  | "AUTHORIZE_CONFIRMATION_REQUIRED"
  | "TRANSPORT_HTTP_ERROR"
  | "ENV_FILE_MISSING"
  | "ENV_PARSE_ERROR"
  | "ENV_UNKNOWN_KEY"
  | "ENV_DUPLICATE_KEY"
  | "ENV_MISSING_KEY"
  | "ENV_BAD_VALUE"
  | "CONFIG_INVALID"
  | "MANIFEST_EMPTY"
  | "MANIFEST_ORDER"
  | "MANIFEST_RANGE"
  | "DUPLICATE_PREFIX"
  | "MISSING_MIGRATION"
  | "EXTRA_MIGRATION"
  | "HASH_MISMATCH"
  | "SENTINEL_PROTECTION";

// Fixed messages — a detail may name a step id, key name, or filename, never a value.
const MESSAGES: Record<A7RunnerFailureCode, string> = {
  INVALID_ARGS: "invalid arguments: pass exactly one known step id (and optionally --dry-run)",
  UNKNOWN_STEP: "unknown step id; only allowlisted steps may run",
  LIVE_CONFIRMATION_REQUIRED: "live execution requires the exact A7 live confirmation phrase; refusing",
  AUTHORIZE_CONFIRMATION_REQUIRED: "the authorization probe requires its exact confirmation phrase; refusing",
  TRANSPORT_HTTP_ERROR: "the A7 query endpoint returned an error; the step was stopped at the failing request",
  ENV_FILE_MISSING: ".env.a7 not found at the repository root (required; no other source is consulted)",
  ENV_PARSE_ERROR: ".env.a7 has a line that is not KEY=VALUE, a comment, or blank",
  ENV_UNKNOWN_KEY: ".env.a7 contains a key outside the allowed set",
  ENV_DUPLICATE_KEY: ".env.a7 defines the same key twice",
  ENV_MISSING_KEY: ".env.a7 is missing a required key",
  ENV_BAD_VALUE: ".env.a7 has a malformed value for a key",
  CONFIG_INVALID: "A7 identity guard rejected the .env.a7 configuration",
  MANIFEST_EMPTY: "step manifest is empty",
  MANIFEST_ORDER: "manifest entries are not in strictly ascending prefix order",
  MANIFEST_RANGE: "a manifest entry's prefix is outside the step's approved range",
  DUPLICATE_PREFIX: "duplicate numeric migration prefix on disk",
  MISSING_MIGRATION: "a manifest migration file is missing on disk",
  EXTRA_MIGRATION: "an unexpected .sql file exists in supabase/migrations",
  HASH_MISMATCH: "a migration file's SHA-256 does not match its approved pinned hash",
  SENTINEL_PROTECTION: "migration SQL references a7_guard; the sentinel must never be touched by migrations",
};

export class A7RunnerError extends Error {
  readonly code: A7RunnerFailureCode;
  readonly detail?: string; // step id / key name / filename ONLY — never a value
  constructor(code: A7RunnerFailureCode, detail?: string) {
    super(`A7 RUNNER REFUSED [${code}]: ${MESSAGES[code]}${detail ? ` (${detail})` : ""}`);
    this.name = "A7RunnerError";
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing — only an allowlisted step id (plus optional --dry-run).
// No --sql / --query / stdin / file paths / env-supplied SQL, ever.
// ---------------------------------------------------------------------------

export function parseCliArgs(argv: readonly string[]): { stepId: A7StepId; dryRun: true } {
  const rest: string[] = [];
  for (const arg of argv) {
    if (arg === "--dry-run") continue; // the only accepted flag, and also the default
    rest.push(arg);
  }
  if (rest.length !== 1 || rest[0].startsWith("-")) throw new A7RunnerError("INVALID_ARGS");
  const stepId = rest[0];
  if (!Object.prototype.hasOwnProperty.call(A7_STEPS, stepId)) {
    throw new A7RunnerError("UNKNOWN_STEP", stepId.slice(0, 64));
  }
  // dryRun is always true in this build: there is no flag that selects live mode.
  return { stepId: stepId as A7StepId, dryRun: true };
}

// ---------------------------------------------------------------------------
// .env.a7 parsing & validation — the only secret source; no fallbacks.
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type A7EnvFile = Readonly<Record<(typeof ENV_A7_ALLOWED_KEYS)[number], string>>;

export function parseEnvA7(content: string): A7EnvFile {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) throw new A7RunnerError("ENV_PARSE_ERROR");
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (!(ENV_A7_ALLOWED_KEYS as readonly string[]).includes(key)) {
      throw new A7RunnerError("ENV_UNKNOWN_KEY", key.slice(0, 64));
    }
    if (key in out) throw new A7RunnerError("ENV_DUPLICATE_KEY", key);
    out[key] = value;
  }
  for (const key of ENV_A7_ALLOWED_KEYS) {
    if (!(key in out) || out[key] === "") throw new A7RunnerError("ENV_MISSING_KEY", key);
  }
  if (!UUID_RE.test(out.A7_SENTINEL_TOKEN)) throw new A7RunnerError("ENV_BAD_VALUE", "A7_SENTINEL_TOKEN");
  return out as A7EnvFile;
}

/** Run the full identity guard over the parsed file. Throws; never echoes values. */
export function validateA7EnvConfig(env: A7EnvFile): void {
  const result = checkA7Config(env);
  if (!result.ok) throw new A7RunnerError("CONFIG_INVALID", result.code);
}

// ---------------------------------------------------------------------------
// Manifest validation — ordered, hash-pinned, closed-world.
// ---------------------------------------------------------------------------

export type DiskMigration = { readonly file: string; readonly sha256: string };

const prefixOf = (file: string): number | null => {
  const m = /^(\d{4})_[^/\\]+\.sql$/.exec(file);
  return m ? Number(m[1]) : null;
};

const STEP_RANGES: Record<A7StepId, { min: number; max: number }> = {
  "baseline-0001-0064": { min: 1, max: 64 },
  "apply-0065": { min: 65, max: 65 },
  "apply-0066": { min: 66, max: 66 },
};

/**
 * Validate one step's manifest against the on-disk migration directory.
 * `disk` must be the COMPLETE listing of supabase/migrations *.sql files with
 * their SHA-256 hashes. Fails closed on: duplicate prefixes anywhere on disk,
 * manifest entries out of ascending order or outside the step's range, any
 * manifest file missing on disk, any hash mismatch, any .sql file on disk that
 * no approved step accounts for, and any on-disk file inside the step's range
 * that the step's manifest does not list.
 */
export function validateStepManifest(stepId: A7StepId, disk: readonly DiskMigration[]): readonly A7ManifestEntry[] {
  if (!Object.prototype.hasOwnProperty.call(A7_STEPS, stepId)) throw new A7RunnerError("UNKNOWN_STEP");
  // Widened from the `as const` tuple so the emptiness check below stays a real
  // runtime guard (a JS caller can reach here with a tampered manifest).
  const manifest: readonly A7ManifestEntry[] = A7_STEPS[stepId].migrations;
  if (manifest.length === 0) throw new A7RunnerError("MANIFEST_EMPTY", stepId);

  // Closed world: every on-disk .sql must have a well-formed, unique prefix.
  const seen = new Map<number, string>();
  for (const d of disk) {
    const p = prefixOf(d.file);
    if (p === null) throw new A7RunnerError("EXTRA_MIGRATION", d.file);
    const prior = seen.get(p);
    if (prior !== undefined) throw new A7RunnerError("DUPLICATE_PREFIX", `${prior} / ${d.file}`);
    seen.set(p, d.file);
  }

  // Every on-disk file must be accounted for by SOME approved step (no strays).
  const allApproved = new Set<string>(
    (Object.keys(A7_STEPS) as A7StepId[]).flatMap((id) => A7_STEPS[id].migrations.map((m) => m.file)),
  );
  for (const d of disk) {
    if (!allApproved.has(d.file)) throw new A7RunnerError("EXTRA_MIGRATION", d.file);
  }

  // The step's manifest: strictly ascending, inside the approved range.
  const { min, max } = STEP_RANGES[stepId];
  let last = 0;
  for (const entry of manifest) {
    const p = prefixOf(entry.file);
    if (p === null || p < min || p > max) throw new A7RunnerError("MANIFEST_RANGE", entry.file);
    if (p <= last) throw new A7RunnerError("MANIFEST_ORDER", entry.file);
    last = p;
  }

  // Every in-range on-disk file must be in the step manifest (nothing skipped),
  // and every manifest file must exist on disk with the pinned hash.
  const diskByFile = new Map(disk.map((d) => [d.file, d.sha256]));
  for (const d of disk) {
    const p = prefixOf(d.file)!;
    if (p >= min && p <= max && !manifest.some((m) => m.file === d.file)) {
      throw new A7RunnerError("EXTRA_MIGRATION", d.file);
    }
  }
  for (const entry of manifest) {
    const actual = diskByFile.get(entry.file);
    if (actual === undefined) throw new A7RunnerError("MISSING_MIGRATION", entry.file);
    if (actual !== entry.sha256) throw new A7RunnerError("HASH_MISMATCH", entry.file);
  }
  return manifest;
}

// ---------------------------------------------------------------------------
// Sentinel protection — migrations must never touch a7_guard.
// ---------------------------------------------------------------------------

export function checkSentinelProtection(file: string, sql: string): void {
  if (/a7_guard/i.test(sql)) throw new A7RunnerError("SENTINEL_PROTECTION", file);
}

// ---------------------------------------------------------------------------
// Dry run (THE ONLY MODE IN THIS BUILD) — zero HTTP by construction: this
// module imports no network APIs and these code paths call no injected
// network dependency.
// ---------------------------------------------------------------------------

export type DryRunDeps = {
  readonly stepId: A7StepId;
  /** Complete listing of supabase/migrations *.sql with sha256 hashes. */
  readonly readDisk: () => readonly DiskMigration[];
  /** Raw SQL of one migration file (for the sentinel-protection scan). */
  readonly readSql: (file: string) => string;
  /** Raw .env.a7 content, or null when the file does not exist. */
  readonly readEnvFile: () => string | null;
};

export type DryRunCheck = { readonly name: string; readonly ok: boolean; readonly detail?: string };
export type DryRunReport = { readonly ok: boolean; readonly checks: readonly DryRunCheck[] };

const asCheck = (name: string, fn: () => void): DryRunCheck => {
  try {
    fn();
    return { name, ok: true };
  } catch (e) {
    const detail = e instanceof A7RunnerError ? `${e.code}${e.detail ? `: ${e.detail}` : ""}` : "UNEXPECTED_ERROR";
    return { name, ok: false, detail };
  }
};

export function runDryRun(deps: DryRunDeps): DryRunReport {
  const checks: DryRunCheck[] = [];
  let manifest: readonly A7ManifestEntry[] = [];

  checks.push(
    asCheck("manifest+hashes+order+closed-world", () => {
      manifest = validateStepManifest(deps.stepId, deps.readDisk());
    }),
  );
  checks.push(
    asCheck("sentinel-protection (no a7_guard references)", () => {
      for (const entry of manifest) checkSentinelProtection(entry.file, deps.readSql(entry.file));
    }),
  );
  checks.push(
    asCheck("local .env.a7 configuration", () => {
      const raw = deps.readEnvFile();
      if (raw === null) throw new A7RunnerError("ENV_FILE_MISSING");
      validateA7EnvConfig(parseEnvA7(raw));
    }),
  );
  return { ok: checks.every((c) => c.ok), checks };
}

// ---------------------------------------------------------------------------
// Live path. This module stays NETWORK-FREE: the real transport lives in
// scripts/a7-live-transport.ts and is wired in only by the separate operator
// live CLI (scripts/a7-mutate-live.ts). runLiveStep enforces the sequence
// (confirmation -> validation -> guards -> authorize -> mutate -> exit) and
// refuses without the exact confirmation phrase, so even a programmatic
// caller cannot mutate unconfirmed.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Authorization probe — READ-ONLY BY CONSTRUCTION. Its dependency type carries
// no mutation executor, no step id, and no file readers: there is nothing a
// caller could pass that would let it apply a migration or read migration SQL.
// Future first-contact use: verify the live sentinel once, before any mutation
// stage is attempted, without being followed by migrations.
// ---------------------------------------------------------------------------

export type AuthorizationProbeDeps = {
  /** Must be exactly A7_AUTHORIZE_CONFIRMATION_PHRASE or everything is refused. */
  readonly confirmation: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Read-only sentinel verification transport (A7-pinned). */
  readonly executeSentinelQuery: SentinelQueryExecutor;
};

/**
 * Enforced order: exact probe confirmation (refused before anything else) ->
 * checkA7Config (production blocking first; wrong ref/URL/A7_MODE refused
 * BEFORE any network use) -> authorizeA7Mutation (one read-only sentinel
 * query; missing/malformed token refused before the query inside the guard).
 * Returns safe identity metadata only — never tokens, digests, or headers.
 */
export async function runA7AuthorizationProbe(
  deps: AuthorizationProbeDeps,
): Promise<{ eligible: true; ref: string }> {
  if (deps.confirmation !== A7_AUTHORIZE_CONFIRMATION_PHRASE) {
    throw new A7RunnerError("AUTHORIZE_CONFIRMATION_REQUIRED");
  }
  const identity = checkA7Config(deps.env);
  if (!identity.ok) throw new A7GuardError(identity.code, identity.reason);
  const auth = await authorizeA7Mutation(deps.executeSentinelQuery, deps.env);
  return { eligible: auth.eligible, ref: auth.ref };
}

export type LiveStepDeps = {
  /** Must be exactly A7_LIVE_CONFIRMATION_PHRASE or everything is refused. */
  readonly confirmation: string;
  readonly stepId: A7StepId;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readDisk: () => readonly DiskMigration[];
  readonly readSql: (file: string) => string;
  /** Read-only sentinel verification transport (A7-pinned). */
  readonly executeSentinelQuery: SentinelQueryExecutor;
  /** Mutation transport (A7-pinned). Requires the authorization value. */
  readonly executeMutation: (sql: string, file: string, auth: A7MutationAuthorization) => Promise<void>;
};

/**
 * The enforced live sequence. Mutation is unreachable unless every prior stage
 * passed; the authorization value is local to this call and applies to exactly
 * this one step in this one process invocation.
 */
export async function runLiveStep(deps: LiveStepDeps): Promise<{ applied: readonly string[] }> {
  // 0. Deliberate-confirmation gate, before any other work. Exact match only.
  if (deps.confirmation !== A7_LIVE_CONFIRMATION_PHRASE) {
    throw new A7RunnerError("LIVE_CONFIRMATION_REQUIRED");
  }

  // 1. Manifest, hashes, order, closed world, sentinel protection — all first.
  const manifest = validateStepManifest(deps.stepId, deps.readDisk());
  const sqlByFile = new Map<string, string>();
  for (const entry of manifest) {
    const sql = deps.readSql(entry.file);
    checkSentinelProtection(entry.file, sql);
    sqlByFile.set(entry.file, sql);
  }

  // 2. Identity guard (production blocking first). Refuses before any network use.
  const identity = checkA7Config(deps.env);
  if (!identity.ok) throw new A7GuardError(identity.code, identity.reason);
  // `ref` is deliberately widened to string: this re-check must stay a runtime
  // guard even though the type system can prove it unreachable.
  const ref: string = identity.ref;
  if (ref !== A7_PROJECT_REF || ref === (FORBIDDEN_PRODUCTION_REF as string)) {
    throw new A7GuardError("REF_MISMATCH", "live step target is not the pinned A7 project");
  }

  // 3. Sentinel authorization, immediately before the mutation.
  const auth = await authorizeA7Mutation(deps.executeSentinelQuery, deps.env);

  // 4. Execute exactly this one approved step, in manifest order, then return.
  const applied: string[] = [];
  for (const entry of manifest) {
    await deps.executeMutation(sqlByFile.get(entry.file)!, entry.file, auth);
    applied.push(entry.file);
  }
  return { applied };
}
