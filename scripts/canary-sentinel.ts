// Pydent Phase 2B CANARY sentinel — DESIGN + READ-ONLY VERIFICATION. FAILS CLOSED.
//
// The sentinel proves, from INSIDE the database, that a write-capable step is
// pointed at the canary and that the operator deliberately armed it. It is
// the canary counterpart of the A7 sentinel (src/lib/a7-sentinel-guard.ts,
// unchanged) and deliberately lives in a different schema (canary_guard) so
// neither sentinel can satisfy the other.
//
// THIS BUILD CREATES NOTHING. The setup SQL below is a reviewed PROPOSAL; no
// code path executes it (the only transport is read-only). Creating the
// sentinel is its own future approval, run with a separately approved
// write-capable transport.
//
// Differences from the A7 design (both stricter):
//   * The database stores only the SHA-256 digest of the operator token —
//     never the token itself — so a database read can never reveal it.
//   * The token is read from CANARY_SENTINEL_TOKEN in the PROCESS environment
//     only (never a .env file, never NEXT_PUBLIC_*), reduced to a digest in
//     process, and sent only as a BOUND PARAMETER.
//
// Verification is one fixed read-only SELECT returning a count and booleans.
// Every failure uses a fixed message (CanaryError); nothing is interpolated
// from the token, the digest or the database.

import { createHash } from "node:crypto";
import { CANARY_PROJECT_REF, CanaryError, assertCanaryEnvironment } from "./canary-guard";
import type { CanaryReadOnlyExecutor } from "./canary-transport";

export const CANARY_SENTINEL_SCHEMA = "canary_guard";
export const CANARY_SENTINEL_TOKEN_ENV = "CANARY_SENTINEL_TOKEN";

/**
 * PROPOSED (not executed) sentinel DDL. One request, explicit transaction
 * (the observed no-parameter multi-statement behaviour). The checks pin the
 * row to id = 1 and to the canary ref inside the database itself.
 */
export const PROPOSED_CANARY_SENTINEL_DDL = [
  "begin;",
  "create schema canary_guard;",
  "revoke all on schema canary_guard from public, anon, authenticated, service_role;",
  "create table canary_guard.sentinel (",
  "  id integer primary key check (id = 1),",
  `  project_ref text not null check (project_ref = '${CANARY_PROJECT_REF}'),`,
  "  token_sha256 text not null check (token_sha256 ~ '^[0-9a-f]{64}$'),",
  "  created_at timestamptz not null default now()",
  ");",
  "revoke all on table canary_guard.sentinel from public, anon, authenticated, service_role;",
  "commit;",
].join("\n");

/**
 * PROPOSED (not executed) sentinel insert. A SEPARATE request because a bound
 * parameter forces a single statement. $1 = SHA-256 hex of the operator token.
 */
export const PROPOSED_CANARY_SENTINEL_INSERT_SQL =
  `insert into canary_guard.sentinel (id, project_ref, token_sha256) values (1, '${CANARY_PROJECT_REF}', $1)`;

/** Read-only existence probe (never errors when the sentinel is absent). */
export const SQL_SENTINEL_PRESENCE =
  "select to_regnamespace('canary_guard') is not null as schema_present," +
  " to_regclass('canary_guard.sentinel') is not null as table_present";

/** Fixed read-only verification. $1 = SHA-256 hex digest of CANARY_SENTINEL_TOKEN. */
export const CANARY_SENTINEL_VERIFICATION_SQL =
  "select" +
  " (select count(*) from canary_guard.sentinel) as row_count," +
  " (select bool_and(id = 1) from canary_guard.sentinel) as id_ok," +
  ` (select bool_and(project_ref = '${CANARY_PROJECT_REF}') from canary_guard.sentinel) as ref_ok,` +
  " (select bool_and(token_sha256 = $1) from canary_guard.sentinel) as token_ok";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** SHA-256 hex of the normalized operator token. The raw token never leaves the process. */
export const canarySentinelDigest = (token: string): string =>
  createHash("sha256").update(token.toLowerCase(), "utf8").digest("hex");

export type CanaryMutationAuthorization = {
  readonly eligible: true;
  readonly ref: typeof CANARY_PROJECT_REF;
  readonly sentinel: { readonly id: 1; readonly projectRef: typeof CANARY_PROJECT_REF };
};

/**
 * Authorize ONE future canary mutation. Nothing in this build consumes the
 * result (there is no mutation transport); it exists so the future
 * write-capable step has a reviewed, tested gate to call immediately before
 * each mutation. Enforcement order:
 *   1. canary environment guard (forbidden refs first) — no query otherwise;
 *   2. CANARY_SENTINEL_TOKEN present, UUID-shaped, not in NEXT_PUBLIC_* — no query otherwise;
 *   3. one read-only verification query; every mismatch refuses.
 */
export async function authorizeCanaryMutation(
  executeReadOnlyQuery: CanaryReadOnlyExecutor,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CanaryMutationAuthorization> {
  assertCanaryEnvironment(env);

  const token = env[CANARY_SENTINEL_TOKEN_ENV];
  if (token === undefined || token === "") throw new CanaryError("SENTINEL_TOKEN_MISSING");
  if (!UUID_RE.test(token)) throw new CanaryError("SENTINEL_TOKEN_MALFORMED");
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("NEXT_PUBLIC_") && typeof value === "string" && value.toLowerCase().includes(token.toLowerCase())) {
      throw new CanaryError("SENTINEL_TOKEN_EXPOSED");
    }
  }

  let rows: unknown;
  try {
    rows = await executeReadOnlyQuery(CANARY_SENTINEL_VERIFICATION_SQL, [canarySentinelDigest(token)], "sentinel-verification");
  } catch {
    // Fixed message; transport detail is deliberately not propagated.
    throw new CanaryError("SENTINEL_QUERY_FAILED");
  }

  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new CanaryError("SENTINEL_RESULT_MALFORMED");
  }
  const row = rows[0] as Record<string, unknown>;
  const count = typeof row.row_count === "string" ? Number(row.row_count) : row.row_count;
  if (typeof count !== "number" || !Number.isFinite(count)) throw new CanaryError("SENTINEL_RESULT_MALFORMED");
  if (count === 0) throw new CanaryError("SENTINEL_MISSING");
  if (count !== 1) throw new CanaryError("SENTINEL_ROW_COUNT_INVALID");
  if (row.id_ok !== true) throw new CanaryError("SENTINEL_ID_MISMATCH");
  if (row.ref_ok !== true) throw new CanaryError("SENTINEL_REF_MISMATCH");
  if (row.token_ok !== true) throw new CanaryError("SENTINEL_TOKEN_MISMATCH");

  return Object.freeze({
    eligible: true as const,
    ref: CANARY_PROJECT_REF,
    sentinel: Object.freeze({ id: 1 as const, projectRef: CANARY_PROJECT_REF }),
  });
}
