// Pydent A7 sentinel-aware mutation guard — FAILS CLOSED.
//
// SERVER/TOOLING ONLY. Never import this from a client component or any module
// reachable from the browser bundle (it reads the server-only A7_SENTINEL_TOKEN
// env var and imports node:crypto). It is not imported by the application
// runtime at all: normal production behavior (A7_MODE unset) is untouched.
//
// Purpose: every FUTURE A7 database mutation (baseline migrations, 0065, 0066,
// and anything after) must call authorizeA7Mutation() immediately before the
// mutation and proceed only on an `eligible: true` result. This module is NOT
// itself capable of mutating anything: it issues exactly one fixed read-only
// SELECT through the injected executor and returns eligibility metadata — the
// mutation itself lives with the caller, which must hold its own authorization.
// Eligibility requires BOTH, in this order:
//
//   1. The existing target/production-exclusion guard (a7-guard.ts) passes —
//      production blocking stays FIRST and highest priority, and the sentinel
//      is NEVER queried unless the identity guard has already passed.
//   2. The live A7 database holds the sentinel: exactly one row in
//      a7_guard.sentinel with id = 1, project_ref = the pinned A7 ref, and a
//      token matching the operator-provided A7_SENTINEL_TOKEN.
//
// Token hygiene (never log, store, or transmit either token):
//   * The operator token is read from A7_SENTINEL_TOKEN (no NEXT_PUBLIC prefix,
//     so Next.js can never inline it into a client bundle) and is reduced to a
//     SHA-256 hex digest IN PROCESS, so the raw token never leaves this process.
//   * The verification SQL text is a fixed constant; the digest travels as a
//     BOUND PARAMETER ($1) — the Management API query endpoint supports a
//     `parameters` array (verified against its OpenAPI schema and live with a
//     read-only probe), so no secret-derived value is ever part of SQL text.
//   * The comparison runs inside PostgreSQL using the BUILT-IN sha256()
//     (pg_catalog, PostgreSQL >= 11 — verified present and correct in A7
//     read-only; no extension needed), so the database token is never returned
//     to the caller. The query yields booleans and a row count only.
//   * Every error thrown here uses a FIXED message per failure code — no
//     interpolation — so no secret can ever reach an error message or log.
//   * The injected executor receives only the SQL string and the digest
//     parameter; this module builds no HTTP requests and holds no credentials.

import { createHash } from "node:crypto";
import { A7_PROJECT_REF, checkA7Config, A7GuardError } from "@/lib/a7-guard";

export type A7SentinelFailureCode =
  | "SENTINEL_TOKEN_MISSING" // A7_SENTINEL_TOKEN not set (or empty)
  | "SENTINEL_TOKEN_MALFORMED" // not a UUID
  | "SENTINEL_TOKEN_EXPOSED" // the token value appears in a NEXT_PUBLIC_* env var
  | "SENTINEL_QUERY_FAILED" // verification query errored (schema/table missing, or unreachable)
  | "SENTINEL_RESULT_MALFORMED" // executor returned something that is not one well-formed row
  | "SENTINEL_MISSING" // zero sentinel rows
  | "SENTINEL_ROW_COUNT_INVALID" // more than one sentinel row
  | "SENTINEL_ID_MISMATCH" // id != 1
  | "SENTINEL_REF_MISMATCH" // project_ref != A7 ref
  | "SENTINEL_TOKEN_MISMATCH"; // database token != operator token

// Fixed messages only — never interpolate anything into these.
const FAILURE_MESSAGES: Record<A7SentinelFailureCode, string> = {
  SENTINEL_TOKEN_MISSING: "A7_SENTINEL_TOKEN is not set; mutations are not authorized",
  SENTINEL_TOKEN_MALFORMED: "A7_SENTINEL_TOKEN is not a well-formed UUID; refusing",
  SENTINEL_TOKEN_EXPOSED: "A7_SENTINEL_TOKEN value appears in a NEXT_PUBLIC_* variable; refusing (client-bundle exposure)",
  SENTINEL_QUERY_FAILED: "sentinel verification query failed (sentinel missing or database unreachable); refusing",
  SENTINEL_RESULT_MALFORMED: "sentinel verification returned a malformed result; refusing",
  SENTINEL_MISSING: "A7 sentinel row is missing; refusing",
  SENTINEL_ROW_COUNT_INVALID: "A7 sentinel does not contain exactly one row; refusing",
  SENTINEL_ID_MISMATCH: "A7 sentinel id is not 1; refusing",
  SENTINEL_REF_MISMATCH: "A7 sentinel project_ref does not match the A7 project; refusing",
  SENTINEL_TOKEN_MISMATCH: "A7 sentinel token does not match A7_SENTINEL_TOKEN; refusing",
};

export class A7SentinelGuardError extends Error {
  readonly code: A7SentinelFailureCode;
  constructor(code: A7SentinelFailureCode) {
    super(`A7 SENTINEL GUARD REFUSED [${code}]: ${FAILURE_MESSAGES[code]}`);
    this.name = "A7SentinelGuardError";
    this.code = code;
  }
}

/**
 * Executes one read-only SQL statement with bound parameters against the
 * ALREADY-VERIFIED A7 project and resolves with the result rows (the
 * Management API query endpoint shape: an array of row objects; its body
 * takes { query, parameters, read_only }). It must reject on any transport or
 * SQL error. Injected so this module holds no credentials and tests use pure
 * mocks. This guard only ever passes it the fixed SENTINEL_VERIFICATION_SQL
 * and one digest parameter — never a mutation.
 */
export type SentinelQueryExecutor = (sql: string, parameters: readonly string[]) => Promise<unknown>;

export type A7MutationAuthorization = {
  eligible: true;
  ref: string; // the verified A7 project ref (never a token)
  sentinel: { id: 1; projectRef: string }; // safe identity metadata only
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Fixed verification SQL. Contains no secret and no secret-derived value; the
 * operator token's SHA-256 hex digest is bound as $1. sha256() here is the
 * PostgreSQL built-in (pg_catalog), not an extension function.
 */
export const SENTINEL_VERIFICATION_SQL =
  "select" +
  " (select count(*) from a7_guard.sentinel) as row_count," +
  " (select bool_and(id = 1) from a7_guard.sentinel) as id_ok," +
  ` (select bool_and(project_ref = '${A7_PROJECT_REF}') from a7_guard.sentinel) as ref_ok,` +
  " (select bool_and(encode(sha256(convert_to(token::text, 'UTF8')), 'hex') = $1) from a7_guard.sentinel) as token_ok";

/**
 * Authorize one A7 mutation. Throws A7GuardError (identity/production) or
 * A7SentinelGuardError (sentinel) on ANY problem; returns safe metadata
 * otherwise. The caller (the future mutation runner) must invoke this
 * immediately before each authorized mutation — eligibility is advisory and
 * this module performs no mutation itself. Order of enforcement:
 *   1. checkA7Config: production blocking first, then full A7 identity.
 *      On failure the sentinel is NOT queried (executeQuery is never called).
 *   2. A7_SENTINEL_TOKEN present, UUID-shaped, and not leaked into any
 *      NEXT_PUBLIC_* variable. On failure the sentinel is NOT queried.
 *   3. One read-only sentinel verification query; every mismatch refuses.
 */
export async function authorizeA7Mutation(
  executeQuery: SentinelQueryExecutor,
  env: Env = process.env,
): Promise<A7MutationAuthorization> {
  // 1. Target identity + production exclusion (production outranks everything,
  //    inside checkA7Config). No sentinel access unless this passes.
  const identity = checkA7Config(env);
  if (!identity.ok) throw new A7GuardError(identity.code, identity.reason);

  // 2. Operator token: present, well-formed, and server-side only.
  const token = env.A7_SENTINEL_TOKEN;
  if (token === undefined || token === "") throw new A7SentinelGuardError("SENTINEL_TOKEN_MISSING");
  if (!UUID_RE.test(token)) throw new A7SentinelGuardError("SENTINEL_TOKEN_MALFORMED");
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("NEXT_PUBLIC_") && typeof value === "string" && value.includes(token)) {
      throw new A7SentinelGuardError("SENTINEL_TOKEN_EXPOSED");
    }
  }

  // 3. Verify the live sentinel. The raw token stays in this process; only its
  //    SHA-256 digest travels, as a bound parameter; the comparison happens
  //    inside PostgreSQL; only booleans and a count come back.
  const digest = createHash("sha256").update(token.toLowerCase()).digest("hex");
  let rows: unknown;
  try {
    rows = await executeQuery(SENTINEL_VERIFICATION_SQL, [digest]);
  } catch {
    // Fixed message; the underlying error is deliberately not propagated so no
    // transport detail (URLs, headers, SQL echoes) can reach logs through us.
    throw new A7SentinelGuardError("SENTINEL_QUERY_FAILED");
  }

  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new A7SentinelGuardError("SENTINEL_RESULT_MALFORMED");
  }
  const row = rows[0] as Record<string, unknown>;
  const count = typeof row.row_count === "string" ? Number(row.row_count) : row.row_count;
  if (typeof count !== "number" || !Number.isFinite(count)) throw new A7SentinelGuardError("SENTINEL_RESULT_MALFORMED");
  if (count === 0) throw new A7SentinelGuardError("SENTINEL_MISSING");
  if (count !== 1) throw new A7SentinelGuardError("SENTINEL_ROW_COUNT_INVALID");
  if (row.id_ok !== true) throw new A7SentinelGuardError("SENTINEL_ID_MISMATCH");
  if (row.ref_ok !== true) throw new A7SentinelGuardError("SENTINEL_REF_MISMATCH");
  if (row.token_ok !== true) throw new A7SentinelGuardError("SENTINEL_TOKEN_MISMATCH");

  return { eligible: true, ref: identity.ref, sentinel: { id: 1, projectRef: A7_PROJECT_REF } };
}
