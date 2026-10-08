// Pydent Phase 2B CANARY write-capability probe — W1/W2 ONLY. FAILS CLOSED.
//
// AUTHORIZED SCOPE (operator approval, 2026-10-08): exactly two probe
// requests against the pinned canary endpoint, sent with read_only: false.
//   W1 — SELECT-only identity and transaction-state introspection.
//   W2 — temporary table inside an explicit transaction, one test row,
//        ROLLBACK, in-session verification that the temp table is gone.
//   W3 — failure-atomicity probe (live run separately approved and completed
//        2026-10-08: atomic rollback confirmed): a deliberately failing
//        multi-statement request in the dedicated canary_probe_w3_atomicity
//        schema, judged solely by read-only absence checks afterwards. Its
//        cleanup is a reviewed PROPOSAL that no code path can execute.
//   P1 — sentinel creation executor (live run separately approved and
//        completed 2026-10-08: sentinel created and verified): exactly the two
//        reviewed requests from canary-sentinel.ts, reused verbatim — the
//        canary_guard DDL with its privilege revocations, then the
//        parameterized insert of the operator token's SHA-256 digest. The only
//        argument any transport member accepts is that 64-hex digest; neither
//        the token nor the digest is ever printed, logged or embedded in an
//        error message.
//   P2 — privilege hardening executor (IMPLEMENTED OFFLINE ONLY; live
//        execution requires its own separate approval): exactly the reviewed
//        PROPOSED_PRIVILEGE_HARDENING_SQL from canary-plan-lib.ts, reused
//        verbatim. Sentinel-gated (authorizeCanaryMutation before the write),
//        with the full default-ACL posture read and snapshotted before the
//        request and re-verified after it: API-role table/sequence defaults
//        gone, global defaults still absent, postgres function defaults and
//        supabase_admin defaults byte-identical to the baseline.
//   P3 — migration transport (IMPLEMENTED OFFLINE ONLY; each live step is a
//        separate operator approval, orchestrated by canary-migrate-lib.ts):
//        runManifestMigration sends one hash-pinned migration file wrapped in
//        begin/commit. The allowlist for this path is the 68 reviewed SHA-256
//        hashes of the pinned manifest (itself source-hash-pinned by
//        canary-manifest-check): SQL that does not hash to a pinned entry is
//        refused, so this is still not a generic SQL interface. The canary's
//        supabase_migrations history is NEVER written (the preflight requires
//        0 rows); step markers are the migrations' own objects, committed
//        atomically within the same transaction as the migration itself.
// NOTHING ELSE. This module is NOT a general-purpose SQL interface: the only
// exported network surface is runW1/runW2, each of which sends one frozen SQL
// constant. An internal allowlist refuses any other text as defense in depth.
// Not authorized here (and not expressible through this surface): persistent
// DDL, DROP/TRUNCATE/DELETE, sentinel creation, privilege hardening,
// migrations, W3 failure-atomicity probing.
//
// Credentials: NONE held here (same posture as canary-transport.ts). The
// session proxy injects the canary-scoped Management API secret; requests
// carry only a Content-Type header. The canary environment guard runs at
// construction and the pinned endpoint is re-checked before every request.
//
// Sequencing is enforced by runCanaryWriteProbe:
//   blank-state baseline (read-only) -> W1 -> gate on expected role and
//   writable transaction state -> W2 -> gate on confirmed rollback ->
//   read-only re-verification that the canary is still blank.
// A 401/403 on W1 is a FINDING (token is not write-scoped), not a crash: the
// probe reports it and never attempts W2. Any other surprise stops the run.

import {
  CANARY_PROJECT_REF,
  CANARY_QUERY_ENDPOINT,
  CanaryError,
  assertCanaryEndpoint,
  assertCanaryEnvironment,
  assertNoForbiddenRef,
  scrubCanaryText,
} from "./canary-guard";
import type { CanaryFetchLike, CanaryReadOnlyExecutor } from "./canary-transport";
import {
  CANARY_SENTINEL_TOKEN_ENV,
  PROPOSED_CANARY_SENTINEL_DDL,
  PROPOSED_CANARY_SENTINEL_INSERT_SQL,
  SQL_SENTINEL_PRESENCE,
  authorizeCanaryMutation,
  canarySentinelDigest,
} from "./canary-sentinel";
import {
  PROPOSED_PRIVILEGE_HARDENING_SQL,
  SQL_DEFAULT_ACL_API_ROLE_GRANTS,
  scanTransactionSafety,
  wrapInTransaction,
} from "./canary-plan-lib";
import { A7_STEPS } from "./a7-manifest";
import { sha256Hex } from "./canary-manifest-check";

// ------------------------------------------------------------ errors

export type CanaryProbeFailureCode =
  | "PROBE_SQL_NOT_ALLOWLISTED" // internal send() was handed text that is not W1/W2 (should be unreachable)
  | "PROBE_HTTP_ERROR"
  | "PROBE_RESULT_MALFORMED"
  | "BASELINE_NOT_BLANK" // the canary is not blank before W1; probing a non-blank canary was not approved
  | "W1_ROLE_UNEXPECTED" // executing role is not the expected write-path role
  | "W1_TX_STATE_UNEXPECTED" // transaction state is not writable in the expected way
  | "W2_ROLLBACK_NOT_CONFIRMED" // the in-session rollback evidence did not come back all-true
  | "STATE_CHANGED_AFTER_PROBE" // the post-probe read-only verification differs from the baseline
  | "W3_SCHEMA_PRESENT" // the W3 probe schema already exists; W3 refuses to send anything
  | "W3_CLEANUP_NOT_AUTHORIZED" // the W3 cleanup is a reviewed proposal; executing it is a separate approval
  | "P1_DIGEST_INVALID" // the sentinel insert's bound parameter is not a 64-hex SHA-256 digest
  | "P1_ALREADY_PRESENT" // canary_guard (or its sentinel table) already exists; P1 refuses to send anything
  | "P1_DDL_NOT_VISIBLE" // request A reported success but the schema/table are not visible read-only
  | "P1_ACL_UNEXPECTED" // actual ACLs/ownership after request A are not the expected locked-down posture
  | "P2_BASELINE_ACL_UNEXPECTED" // the pre-P2 defaults are not the known permissive posture; refusing to send
  | "P2_GLOBAL_ACL_PRESENT" // a global (all-schema) default ACL exists; the schema-scoped revoke would not cover it
  | "P2_HARDENING_INCOMPLETE" // API-role table/sequence defaults survived the hardening request
  | "P2_UNRELATED_ACL_CHANGED" // postgres function defaults or supabase_admin defaults drifted from the baseline
  | "P3_FILE_NOT_IN_MANIFEST" // the named file (with its claimed hash) is not a pinned manifest entry
  | "P3_FILE_HASH_MISMATCH" // the provided SQL does not hash to the pinned manifest value
  | "P3_TRANSACTION_UNSAFE" // the file contains statements that cannot run inside one wrapped transaction
  | "P9_PARAMS_INVALID"; // a P9 validation statement's bound parameters fail their declared shape

const PROBE_MESSAGES: Record<CanaryProbeFailureCode, string> = {
  PROBE_SQL_NOT_ALLOWLISTED: "probe transport only sends the frozen W1/W2 SQL; refusing other text",
  PROBE_HTTP_ERROR: "the canary query endpoint returned an error; the probe stopped at the failing request",
  PROBE_RESULT_MALFORMED: "the canary query endpoint returned a result the probe cannot interpret; stopping",
  BASELINE_NOT_BLANK: "the canary is not blank; the approved probe only runs against a blank canary",
  W1_ROLE_UNEXPECTED: "W1 returned an unexpected executing role; stopping before W2",
  W1_TX_STATE_UNEXPECTED: "W1 returned an unexpected transaction state; stopping before W2",
  W2_ROLLBACK_NOT_CONFIRMED: "W2 could not confirm the rollback from inside the session; stopping",
  STATE_CHANGED_AFTER_PROBE: "read-only verification after the probe differs from the baseline; investigate",
  W3_SCHEMA_PRESENT: "the W3 probe schema already exists on the canary; W3 refuses to run until it is investigated",
  W3_CLEANUP_NOT_AUTHORIZED: "the W3 cleanup SQL is a reviewed proposal only; no code path in this build may execute it",
  P1_DIGEST_INVALID: "the sentinel insert only accepts a single 64-hex SHA-256 digest parameter; refusing",
  P1_ALREADY_PRESENT: "the canary_guard schema or sentinel table already exists; P1 stopped before any request",
  P1_DDL_NOT_VISIBLE: "request A reported success but the sentinel schema/table are not visible; partial setup — stopping",
  P1_ACL_UNEXPECTED: "the sentinel schema/table ACLs or ownership are not the expected locked-down posture; stopping before the insert",
  P2_BASELINE_ACL_UNEXPECTED: "the current default privileges are not the known permissive posture; P2 stopped before any request",
  P2_GLOBAL_ACL_PRESENT: "a global default ACL exists; the schema-scoped revocations would not remove it — stopping",
  P2_HARDENING_INCOMPLETE: "API-role table/sequence default grants remain after the hardening request; stopping",
  P2_UNRELATED_ACL_CHANGED: "default privileges outside P2's scope changed (postgres functions or supabase_admin); stopping",
  P3_FILE_NOT_IN_MANIFEST: "the file is not a hash-pinned manifest entry; the migration transport refuses it",
  P3_FILE_HASH_MISMATCH: "the SQL does not hash to the pinned manifest value; the migration transport refuses it",
  P3_TRANSACTION_UNSAFE: "the file contains statements that cannot run inside one wrapped transaction; refusing",
  P9_PARAMS_INVALID: "a validation statement's bound parameters do not match their declared shape; refusing",
};

export class CanaryProbeError extends Error {
  readonly code: CanaryProbeFailureCode;
  /** Scrubbed transport text / check name ONLY — never a secret value. */
  readonly detail?: string;
  constructor(code: CanaryProbeFailureCode, detail?: string) {
    super(`CANARY PROBE STOPPED [${code}]: ${PROBE_MESSAGES[code]}${detail ? ` (${detail})` : ""}`);
    this.name = "CanaryProbeError";
    this.code = code;
    this.detail = detail;
  }
}

// ------------------------------------------------------------ the two frozen requests

/** W1 — SELECT-only. Sent with read_only: false purely to observe the write path's session. */
export const CANARY_PROBE_W1_SQL =
  "select current_user as role_name, session_user as session_role," +
  " current_setting('transaction_read_only') as transaction_read_only," +
  " current_setting('default_transaction_read_only') as default_transaction_read_only," +
  " current_setting('server_version_num') as server_version_num;";

/**
 * W2 — reversible by construction. The temp table exists only in this
 * session and is additionally rolled back; the trailing SELECT (the API
 * returns only the last statement's rows) proves from inside the same
 * session that the rollback was honoured: the temp table is gone and the
 * session-level GUC set inside the transaction reverted.
 */
export const CANARY_PROBE_W2_SQL = [
  "begin;",
  "select set_config('canary.probe', 'armed', false);",
  "create temporary table canary_write_probe_tmp (id int primary key);",
  "insert into canary_write_probe_tmp values (1);",
  "rollback;",
  "select to_regclass('pg_temp.canary_write_probe_tmp') is null as temp_table_gone,",
  "       coalesce(current_setting('canary.probe', true), '') <> 'armed' as guc_reverted;",
].join("\n");

/** The expected executing role on the write path (the plan's hardening assumes it). */
export const EXPECTED_WRITE_PATH_ROLE = "postgres";

/**
 * W3 — failure atomicity. The dedicated schema name is unique to this probe:
 * no migration, application code path or guard schema references it (the 68
 * migrations touch only public/supabase_migrations; the guards use a7_guard
 * and canary_guard). The request mirrors exactly how the execution plan sends
 * a migration file — one request, explicit begin ... commit — with a
 * guaranteed division-by-zero error BEFORE the commit, so the request MUST
 * fail. The SQL error is the expected outcome, not evidence of atomicity:
 * only the read-only absence checks afterwards decide the result.
 */
export const CANARY_W3_PROBE_SCHEMA = "canary_probe_w3_atomicity";

export const CANARY_PROBE_W3_SQL = [
  "begin;",
  `create schema ${CANARY_W3_PROBE_SCHEMA};`,
  `create table ${CANARY_W3_PROBE_SCHEMA}.probe_object (id int primary key);`,
  `insert into ${CANARY_W3_PROBE_SCHEMA}.probe_object values (1);`,
  "select 1/0 as deliberate_failure;",
  "commit;",
].join("\n");

/** Read-only absence check, run BEFORE (must be absent) and AFTER (absence = atomic rollback). */
export const SQL_W3_ABSENCE_CHECK =
  `select to_regnamespace('${CANARY_W3_PROBE_SCHEMA}') is null as schema_absent,` +
  ` to_regclass('${CANARY_W3_PROBE_SCHEMA}.probe_object') is null as table_absent`;

/**
 * PROPOSED (NOT EXECUTABLE) cleanup, needed only if W3 ever finds partial
 * persistence. It is deliberately NOT in the transport allowlist, so no code
 * path in this build can send it; runW3Cleanup below refuses unconditionally.
 * Executing it is its own future approval, followed by SQL_W3_ABSENCE_CHECK.
 */
export const PROPOSED_W3_CLEANUP_SQL = `drop schema if exists ${CANARY_W3_PROBE_SCHEMA} cascade;`;

/** The W3 cleanup gate for this build: always refuses. See PROPOSED_W3_CLEANUP_SQL. */
export function runW3Cleanup(): never {
  throw new CanaryProbeError("W3_CLEANUP_NOT_AUTHORIZED");
}

/**
 * P2 — the privilege hardening request, REUSED VERBATIM from the reviewed
 * proposal in canary-plan-lib.ts (no new SQL is authored here). One request,
 * explicit transaction, no parameters — the shape W3 proved failure-atomic.
 */
export const P2_HARDENING_SQL = PROPOSED_PRIVILEGE_HARDENING_SQL;

/**
 * Read-only default-ACL detail for schema public: one row per (owner,
 * objtype, grantee, privilege). The live review of 2026-10-08 showed every
 * permissive entry here is schema-scoped, which is what makes the
 * schema-scoped revocations sufficient.
 */
export const SQL_P2_ACL_DETAIL =
  "select pg_get_userbyid(d.defaclrole) as owner, d.defaclobjtype::text as objtype," +
  " pg_get_userbyid(a.grantee) as grantee, a.privilege_type" +
  " from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a" +
  " where d.defaclnamespace = 'public'::regnamespace order by 1, 2, 3, 4";

/** Read-only GLOBAL (all-schema) default ACLs — must be empty before AND after P2. */
export const SQL_P2_ACL_GLOBAL =
  "select pg_get_userbyid(d.defaclrole) as owner, d.defaclobjtype::text as objtype," +
  " pg_get_userbyid(a.grantee) as grantee, a.privilege_type" +
  " from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a" +
  " where d.defaclnamespace = 0 order by 1, 2, 3, 4";

/**
 * P1 — the two sentinel-setup requests, REUSED VERBATIM from the committed
 * proposal in canary-sentinel.ts (no new SQL is authored here). Request A is
 * the no-parameter DDL (the request shape W3 proved failure-atomic); request
 * B is the parameterized single-statement insert of the token digest.
 */
export const P1_REQUEST_A_SQL = PROPOSED_CANARY_SENTINEL_DDL;
export const P1_REQUEST_B_SQL = PROPOSED_CANARY_SENTINEL_INSERT_SQL;

const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const UUID_SHAPE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read CANARY_SENTINEL_TOKEN from the PROCESS environment only and reduce it
 * to its SHA-256 digest in process. Same refusals as the committed
 * verification gate: missing, non-UUID, or echoed in any NEXT_PUBLIC_* value.
 * Neither the token nor the digest ever reaches a message or a log.
 */
export function deriveSentinelDigestFromEnv(env: Readonly<Record<string, string | undefined>>): string {
  const token = env[CANARY_SENTINEL_TOKEN_ENV];
  if (token === undefined || token === "") throw new CanaryError("SENTINEL_TOKEN_MISSING");
  if (!UUID_SHAPE_RE.test(token)) throw new CanaryError("SENTINEL_TOKEN_MALFORMED");
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("NEXT_PUBLIC_") && typeof value === "string" && value.toLowerCase().includes(token.toLowerCase())) {
      throw new CanaryError("SENTINEL_TOKEN_EXPOSED");
    }
  }
  return canarySentinelDigest(token);
}

/**
 * Read-only check of the ACTUAL post-DDL posture (not merely that the REVOKEs
 * ran): no API role holds any schema or table privilege, both objects are
 * owned by postgres, and no default ACL is scoped to canary_guard.
 */
export const SQL_P1_ACL_CHECK =
  "select" +
  " has_schema_privilege('anon', 'canary_guard', 'usage,create') as anon_schema," +
  " has_schema_privilege('authenticated', 'canary_guard', 'usage,create') as authenticated_schema," +
  " has_schema_privilege('service_role', 'canary_guard', 'usage,create') as service_role_schema," +
  " has_table_privilege('anon', 'canary_guard.sentinel', 'select,insert,update,delete,truncate,references,trigger') as anon_table," +
  " has_table_privilege('authenticated', 'canary_guard.sentinel', 'select,insert,update,delete,truncate,references,trigger') as authenticated_table," +
  " has_table_privilege('service_role', 'canary_guard.sentinel', 'select,insert,update,delete,truncate,references,trigger') as service_role_table," +
  " (select pg_get_userbyid(nspowner) from pg_namespace where nspname = 'canary_guard') as schema_owner," +
  " (select pg_get_userbyid(relowner) from pg_class where oid = 'canary_guard.sentinel'::regclass) as table_owner," +
  " not exists (select 1 from pg_default_acl d where d.defaclnamespace = to_regnamespace('canary_guard')) as no_default_acl_in_schema";

// ------------------------------------------------------------ probe transport (W1/W2 only)

type ProbeRow = Record<string, unknown>;

export type CanaryWriteProbeTransport = {
  /** HTTP 401/403 resolves authorized:false; any other failure throws. */
  readonly runW1: () => Promise<{ authorized: boolean; row?: ProbeRow; httpStatus?: number }>;
  readonly runW2: () => Promise<ProbeRow>;
  /** W3 EXPECTS the request to fail; every HTTP outcome resolves (never throws on status). */
  readonly runW3: () => Promise<{ requestFailed: boolean; httpStatus: number; errorDetail?: string }>;
  /** P1 request A (sentinel DDL). HTTP 401/403 resolves authorized:false; any other failure throws. */
  readonly runP1Ddl: () => Promise<{ authorized: boolean; httpStatus: number }>;
  /** P1 request B. The ONLY member taking an argument: the 64-hex digest, sent as the bound parameter. */
  readonly runP1Insert: (digestHex: string) => Promise<{ httpStatus: number }>;
  /** P2 hardening request. HTTP 401/403 resolves authorized:false; any other failure throws. */
  readonly runP2Hardening: () => Promise<{ authorized: boolean; httpStatus: number }>;
  /**
   * P3: send ONE hash-pinned migration file, wrapped in begin/commit. The SQL
   * is accepted only when sha256(rawSql) equals the pinned manifest hash for
   * `file` — the allowlist extended to the 68 reviewed migration hashes, not
   * a generic SQL interface. HTTP 401/403 resolves authorized:false.
   */
  readonly runManifestMigration: (rawSql: string, file: string, expectedSha256: string) => Promise<{ authorized: boolean; httpStatus: number }>;
  /**
   * P9: execute ONE frozen validation statement with shape-validated bound
   * parameters and return its rows. Any HTTP failure throws (a raised
   * exception from the reviewed functions, e.g. P0002 on a cross-workspace
   * mismatch, surfaces this way and IS an assertable contract outcome).
   */
  readonly runValidationStatement: (sql: string, parameters: readonly string[], context: string) => Promise<unknown[]>;
};

/** file -> pinned sha256 across all 68 reviewed manifest entries. */
const MANIFEST_PINNED_HASHES: ReadonlyMap<string, string> = new Map(
  Object.values(A7_STEPS).flatMap((s) => s.migrations.map((m) => [m.file, m.sha256] as const)),
);

// ------------------------------------------------------------ P9 validation statements (frozen, parameterized)
//
// The P9 functional validator's ONLY mutation surface: fixed SQL constants,
// every runtime value a bound parameter with a declared, validated shape.
// Mirrors the reviewed A7 Phase 2B validator statements; the canary marker
// prefix is enforced AT THE TRANSPORT on every workspace name, and the
// cleanup's name parameter must embed the same uuid as its id parameter, so a
// delete can never reach a non-validation workspace even if a caller misuses
// the surface. knowledge_chunks is never written directly.

export const P9_VALIDATION_MARKER_PREFIX = "CANARY-2B-VALIDATION";

export const P9_SQL_CREATE_WORKSPACE =
  "insert into public.workspaces (id, name) values ($1::uuid, $2) returning id::text as id";
export const P9_SQL_CREATE_RESOURCE =
  "insert into public.knowledge_resources (id, workspace_id, name, type, status)" +
  " values ($1::uuid, $2::uuid, $3, 'file', 'empty') returning id::text as id";
export const P9_SQL_CREATE_AGENT =
  "insert into public.agents (id, workspace_id, name) values ($1::uuid, $2::uuid, $3) returning id::text as id";
export const P9_SQL_CREATE_ASSIGNMENT =
  "insert into public.agent_knowledge_resources (workspace_id, agent_id, resource_id)" +
  " values ($1::uuid, $2::uuid, $3::uuid)";
export const P9_SQL_APPLY_DOCUMENT_CHANGES =
  "select public.knowledge_apply_document_changes($1::uuid, $2::uuid, $3::uuid, $4::jsonb, '{}'::jsonb) as result";
export const P9_SQL_REINDEX_DOCUMENT =
  "select public.knowledge_reindex_document($1::uuid, $2::uuid, $3, $4::jsonb) as result";
/** Read-only in effect, but the read-only role holds no EXECUTE on it, so it runs on the write path. */
export const P9_SQL_MATCH_CHUNKS =
  "select public.knowledge_match_chunks($1::uuid, $2::uuid, $3, 8) as result";
/** Exact id AND exact marker name, both bound; cascades remove everything the run created. */
export const P9_SQL_CLEANUP_WORKSPACE =
  "delete from public.workspaces where id = $1::uuid and name = $2 returning id::text as id";

type P9ParamKind = "uuid" | "wsname" | "text" | "hash" | "json";
const P9_STATEMENT_SHAPES: ReadonlyMap<string, readonly P9ParamKind[]> = new Map([
  [P9_SQL_CREATE_WORKSPACE, ["uuid", "wsname"]],
  [P9_SQL_CREATE_RESOURCE, ["uuid", "uuid", "text"]],
  [P9_SQL_CREATE_AGENT, ["uuid", "uuid", "text"]],
  [P9_SQL_CREATE_ASSIGNMENT, ["uuid", "uuid", "uuid"]],
  [P9_SQL_APPLY_DOCUMENT_CHANGES, ["uuid", "uuid", "uuid", "json"]],
  [P9_SQL_REINDEX_DOCUMENT, ["uuid", "uuid", "hash", "json"]],
  [P9_SQL_MATCH_CHUNKS, ["uuid", "uuid", "text"]],
  [P9_SQL_CLEANUP_WORKSPACE, ["uuid", "wsname"]],
]);

function assertP9Params(sql: string, parameters: readonly string[], context: string): void {
  const shape = P9_STATEMENT_SHAPES.get(sql);
  if (shape === undefined) throw new CanaryProbeError("PROBE_SQL_NOT_ALLOWLISTED", context);
  if (!Array.isArray(parameters) || parameters.length !== shape.length) throw new CanaryProbeError("P9_PARAMS_INVALID", `${context}: arity`);
  shape.forEach((kind, i) => {
    const p = parameters[i];
    if (typeof p !== "string") throw new CanaryProbeError("P9_PARAMS_INVALID", `${context}: $${i + 1} not a string`);
    assertNoForbiddenRef(p, `${context}: $${i + 1}`);
    const ok =
      kind === "uuid"
        ? UUID_SHAPE_RE.test(p)
        : kind === "wsname"
          ? p === `${P9_VALIDATION_MARKER_PREFIX} ${parameters[0]}` && UUID_SHAPE_RE.test(String(parameters[0]))
          : kind === "hash"
            ? SHA256_HEX_RE.test(p)
            : kind === "json"
              ? ((): boolean => {
                  try {
                    JSON.parse(p);
                    return p.length <= 1_000_000;
                  } catch {
                    return false;
                  }
                })()
              : p.length > 0 && p.length <= 400; // text
    if (!ok) throw new CanaryProbeError("P9_PARAMS_INVALID", `${context}: $${i + 1} fails its ${kind} shape`);
  });
}

const ALLOWLISTED_PROBE_SQL: readonly string[] = Object.freeze([
  CANARY_PROBE_W1_SQL,
  CANARY_PROBE_W2_SQL,
  CANARY_PROBE_W3_SQL,
  P1_REQUEST_A_SQL,
  P1_REQUEST_B_SQL,
  P2_HARDENING_SQL,
]);

export function createCanaryWriteProbeTransport(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: CanaryFetchLike,
): CanaryWriteProbeTransport {
  // Fail closed at construction, exactly like the read-only transport.
  assertCanaryEnvironment(env);
  assertCanaryEndpoint(CANARY_QUERY_ENDPOINT);
  const doFetch: CanaryFetchLike = fetchImpl ?? (globalThis.fetch as unknown as CanaryFetchLike);

  // The one place a request leaves this module. Callers reach it ONLY through
  // `send` (the frozen-SQL allowlist) or `runManifestMigration` (the
  // manifest-hash gate); both gates sit between any caller and this function.
  const post = async (sqlText: string, context: string, boundParameters?: readonly string[]) => {
    assertNoForbiddenRef(sqlText, `${context}: sql`);
    const url = CANARY_QUERY_ENDPOINT;
    assertCanaryEndpoint(url); // re-checked immediately before every request

    const body: Record<string, unknown> = { query: sqlText, read_only: false };
    if (boundParameters !== undefined) body.parameters = [...boundParameters];

    let response: Awaited<ReturnType<CanaryFetchLike>>;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        redirect: "error",
      });
    } catch {
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `${context}: network failure`);
    }
    return response;
  };

  const send = async (sql: string, context: string, boundDigest?: string) => {
    if (!ALLOWLISTED_PROBE_SQL.includes(sql)) throw new CanaryProbeError("PROBE_SQL_NOT_ALLOWLISTED", context);
    // Only the P1 insert carries a bound parameter, and only a 64-hex digest.
    if (sql === P1_REQUEST_B_SQL) {
      if (typeof boundDigest !== "string" || !SHA256_HEX_RE.test(boundDigest)) throw new CanaryProbeError("P1_DIGEST_INVALID", context);
    } else if (boundDigest !== undefined) {
      throw new CanaryProbeError("PROBE_SQL_NOT_ALLOWLISTED", context);
    }
    return post(sql, context, sql === P1_REQUEST_B_SQL && boundDigest !== undefined ? [boundDigest] : undefined);
  };

  const oneRow = async (response: Awaited<ReturnType<CanaryFetchLike>>, context: string): Promise<ProbeRow> => {
    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      throw new CanaryProbeError("PROBE_RESULT_MALFORMED", `${context}: unparseable response`);
    }
    if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
      throw new CanaryProbeError("PROBE_RESULT_MALFORMED", context);
    }
    return rows[0] as ProbeRow;
  };

  const runW1: CanaryWriteProbeTransport["runW1"] = async () => {
    const response = await send(CANARY_PROBE_W1_SQL, "w1");
    if (response.status === 401 || response.status === 403) {
      return { authorized: false, httpStatus: response.status };
    }
    if (!response.ok) {
      let detail = "";
      try {
        detail = scrubCanaryText(await response.text());
      } catch {
        detail = "";
      }
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `w1: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return { authorized: true, row: await oneRow(response, "w1") };
  };

  const runW2: CanaryWriteProbeTransport["runW2"] = async () => {
    const response = await send(CANARY_PROBE_W2_SQL, "w2");
    if (!response.ok) {
      let detail = "";
      try {
        detail = scrubCanaryText(await response.text());
      } catch {
        detail = "";
      }
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `w2: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return oneRow(response, "w2");
  };

  const runW3: CanaryWriteProbeTransport["runW3"] = async () => {
    const response = await send(CANARY_PROBE_W3_SQL, "w3");
    if (response.ok) return { requestFailed: false, httpStatus: response.status };
    let detail = "";
    try {
      detail = scrubCanaryText(await response.text());
    } catch {
      detail = "";
    }
    return { requestFailed: true, httpStatus: response.status, errorDetail: detail || undefined };
  };

  const runP1Ddl: CanaryWriteProbeTransport["runP1Ddl"] = async () => {
    const response = await send(P1_REQUEST_A_SQL, "p1-ddl");
    if (response.status === 401 || response.status === 403) return { authorized: false, httpStatus: response.status };
    if (!response.ok) {
      let detail = "";
      try {
        detail = scrubCanaryText(await response.text());
      } catch {
        detail = "";
      }
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `p1-ddl: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return { authorized: true, httpStatus: response.status };
  };

  const runP1Insert: CanaryWriteProbeTransport["runP1Insert"] = async (digestHex) => {
    const response = await send(P1_REQUEST_B_SQL, "p1-insert", digestHex);
    if (!response.ok) {
      // Fixed detail only: the response could echo the parameter, so no body text is surfaced here.
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `p1-insert: HTTP ${response.status}`);
    }
    return { httpStatus: response.status };
  };

  const runP2Hardening: CanaryWriteProbeTransport["runP2Hardening"] = async () => {
    const response = await send(P2_HARDENING_SQL, "p2-hardening");
    if (response.status === 401 || response.status === 403) return { authorized: false, httpStatus: response.status };
    if (!response.ok) {
      let detail = "";
      try {
        detail = scrubCanaryText(await response.text());
      } catch {
        detail = "";
      }
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `p2-hardening: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return { authorized: true, httpStatus: response.status };
  };

  const runManifestMigration: CanaryWriteProbeTransport["runManifestMigration"] = async (rawSql, file, expectedSha256) => {
    const context = `p3-migration ${typeof file === "string" ? file : "invalid-file"}`;
    if (typeof file !== "string" || typeof rawSql !== "string" || typeof expectedSha256 !== "string" || !SHA256_HEX_RE.test(expectedSha256)) {
      throw new CanaryProbeError("P3_FILE_NOT_IN_MANIFEST", context);
    }
    const pinned = MANIFEST_PINNED_HASHES.get(file);
    if (pinned === undefined || pinned !== expectedSha256) throw new CanaryProbeError("P3_FILE_NOT_IN_MANIFEST", context);
    if (sha256Hex(rawSql) !== pinned) throw new CanaryProbeError("P3_FILE_HASH_MISMATCH", context);
    const scan = scanTransactionSafety(rawSql);
    if (!scan.wrapSafe) throw new CanaryProbeError("P3_TRANSACTION_UNSAFE", `${context}: ${scan.blocking.join("; ")}`);

    const response = await post(wrapInTransaction(rawSql), context);
    if (response.status === 401 || response.status === 403) return { authorized: false, httpStatus: response.status };
    if (!response.ok) {
      let detail = "";
      try {
        detail = scrubCanaryText(await response.text());
      } catch {
        detail = "";
      }
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `${context}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    return { authorized: true, httpStatus: response.status };
  };

  const runValidationStatement: CanaryWriteProbeTransport["runValidationStatement"] = async (sql, parameters, context) => {
    assertP9Params(sql, parameters, String(context));
    const response = await post(sql, `p9 ${String(context)}`, parameters);
    if (!response.ok) {
      let detail = "";
      try {
        detail = scrubCanaryText(await response.text());
      } catch {
        detail = "";
      }
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `p9 ${String(context)}: HTTP ${response.status}${detail ? ` ${detail}` : ""}`);
    }
    let rows: unknown;
    try {
      rows = await response.json();
    } catch {
      throw new CanaryProbeError("PROBE_RESULT_MALFORMED", `p9 ${String(context)}: unparseable response`);
    }
    if (!Array.isArray(rows)) throw new CanaryProbeError("PROBE_RESULT_MALFORMED", `p9 ${String(context)}`);
    return rows;
  };

  return Object.freeze({ runW1, runW2, runW3, runP1Ddl, runP1Insert, runP2Hardening, runManifestMigration, runValidationStatement });
}

// ------------------------------------------------------------ blank-state fingerprint (read-only)

/** One read-only request; every value must indicate an untouched, blank canary. */
export const SQL_PROBE_BLANK_FINGERPRINT =
  "select" +
  " (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public') as public_relations," +
  " (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as public_functions," +
  " (select count(*)::int from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype in ('e','c','d')) as public_types," +
  " coalesce((select count(*)::int from supabase_migrations.schema_migrations), 0) as migration_rows," +
  " to_regnamespace('canary_guard') is null as sentinel_schema_absent," +
  " to_regclass('public.canary_write_probe_tmp') is null as no_persisted_probe_table";

const asInt = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
};

type BlankFingerprint = {
  readonly publicRelations: number;
  readonly publicFunctions: number;
  readonly publicTypes: number;
  readonly migrationRows: number;
  readonly sentinelSchemaAbsent: boolean;
  readonly noPersistedProbeTable: boolean;
};

async function readBlankFingerprint(readOnly: CanaryReadOnlyExecutor, context: string): Promise<BlankFingerprint> {
  const rows = await readOnly(SQL_PROBE_BLANK_FINGERPRINT, [], context);
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new CanaryProbeError("PROBE_RESULT_MALFORMED", context);
  }
  const r = rows[0] as ProbeRow;
  return {
    publicRelations: asInt(r.public_relations),
    publicFunctions: asInt(r.public_functions),
    publicTypes: asInt(r.public_types),
    migrationRows: asInt(r.migration_rows),
    sentinelSchemaAbsent: r.sentinel_schema_absent === true,
    noPersistedProbeTable: r.no_persisted_probe_table === true,
  };
}

const isBlank = (f: BlankFingerprint): boolean =>
  f.publicRelations === 0 &&
  f.publicFunctions === 0 &&
  f.publicTypes === 0 &&
  f.migrationRows === 0 &&
  f.sentinelSchemaAbsent &&
  f.noPersistedProbeTable;

const fingerprintDetail = (f: BlankFingerprint): string =>
  `relations=${f.publicRelations} functions=${f.publicFunctions} types=${f.publicTypes}` +
  ` migration_rows=${f.migrationRows} sentinel_absent=${f.sentinelSchemaAbsent} no_probe_table=${f.noPersistedProbeTable}`;

// ------------------------------------------------------------ orchestration

export type ProbeCheck = { readonly name: string; readonly ok: boolean; readonly detail?: string };

export type CanaryWriteProbeReport = {
  readonly target: typeof CANARY_PROJECT_REF;
  /** null until W1 ran. authorized:false means HTTP 401/403 — the token is not write-scoped. */
  readonly w1: {
    readonly authorized: boolean;
    readonly httpStatus?: number;
    readonly roleName?: string;
    readonly sessionRole?: string;
    readonly transactionReadOnly?: string;
    readonly defaultTransactionReadOnly?: string;
  } | null;
  /** null unless W1 succeeded with the expected role and transaction state. */
  readonly w2: { readonly tempTableGone: boolean; readonly gucReverted: boolean } | null;
  readonly checks: readonly ProbeCheck[];
  /** True when the probe ran to a conclusive, safe end (including the not-authorized finding). */
  readonly completed: boolean;
};

export async function runCanaryWriteProbe(deps: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readOnly: CanaryReadOnlyExecutor;
  readonly probe: CanaryWriteProbeTransport;
}): Promise<CanaryWriteProbeReport> {
  assertCanaryEnvironment(deps.env);
  const checks: ProbeCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  // Baseline: the approved probe only runs against a blank canary.
  const baseline = await readBlankFingerprint(deps.readOnly, "probe-baseline");
  add("baseline (read-only): canary is blank", isBlank(baseline), fingerprintDetail(baseline));
  if (!isBlank(baseline)) throw new CanaryProbeError("BASELINE_NOT_BLANK", fingerprintDetail(baseline));

  // W1 — identity and transaction state on the write path.
  const w1 = await deps.probe.runW1();
  if (!w1.authorized) {
    add("W1: write path authorized", false, `HTTP ${w1.httpStatus}: token is not write-scoped; W2 not attempted`);
    return {
      target: CANARY_PROJECT_REF,
      w1: { authorized: false, httpStatus: w1.httpStatus },
      w2: null,
      checks,
      completed: true, // conclusive finding, nothing was executed on the database
    };
  }
  const row = w1.row ?? {};
  const w1Report = {
    authorized: true as const,
    roleName: typeof row.role_name === "string" ? row.role_name : undefined,
    sessionRole: typeof row.session_role === "string" ? row.session_role : undefined,
    transactionReadOnly: typeof row.transaction_read_only === "string" ? row.transaction_read_only : undefined,
    defaultTransactionReadOnly:
      typeof row.default_transaction_read_only === "string" ? row.default_transaction_read_only : undefined,
  };
  add("W1: write path authorized", true, `role=${w1Report.roleName} session_role=${w1Report.sessionRole}`);

  const roleOk = w1Report.roleName === EXPECTED_WRITE_PATH_ROLE && w1Report.sessionRole === EXPECTED_WRITE_PATH_ROLE;
  add(`W1: executing role is ${EXPECTED_WRITE_PATH_ROLE}`, roleOk, `role=${w1Report.roleName}`);
  if (!roleOk) throw new CanaryProbeError("W1_ROLE_UNEXPECTED", `role=${w1Report.roleName} session_role=${w1Report.sessionRole}`);

  const txOk = w1Report.transactionReadOnly === "off" && w1Report.defaultTransactionReadOnly === "off";
  add("W1: transaction state writable (transaction_read_only=off, default off)", txOk,
    `transaction_read_only=${w1Report.transactionReadOnly} default=${w1Report.defaultTransactionReadOnly}`);
  if (!txOk) {
    throw new CanaryProbeError(
      "W1_TX_STATE_UNEXPECTED",
      `transaction_read_only=${w1Report.transactionReadOnly} default=${w1Report.defaultTransactionReadOnly}`,
    );
  }

  // W2 — temp table + insert inside an explicit transaction, ROLLBACK, in-session verification.
  const w2Row = await deps.probe.runW2();
  const w2Report = { tempTableGone: w2Row.temp_table_gone === true, gucReverted: w2Row.guc_reverted === true };
  add("W2: temp table gone after ROLLBACK (same session)", w2Report.tempTableGone);
  add("W2: transactional session setting reverted by ROLLBACK", w2Report.gucReverted);
  if (!w2Report.tempTableGone || !w2Report.gucReverted) {
    throw new CanaryProbeError("W2_ROLLBACK_NOT_CONFIRMED", `temp_table_gone=${w2Report.tempTableGone} guc_reverted=${w2Report.gucReverted}`);
  }

  // Post-probe: the canary must still be blank, byte-for-byte the same fingerprint.
  const after = await readBlankFingerprint(deps.readOnly, "probe-verification");
  const unchanged = isBlank(after);
  add("verification (read-only): canary still blank after probe", unchanged, fingerprintDetail(after));
  if (!unchanged) throw new CanaryProbeError("STATE_CHANGED_AFTER_PROBE", fingerprintDetail(after));

  return { target: CANARY_PROJECT_REF, w1: w1Report, w2: w2Report, checks, completed: true };
}

// ------------------------------------------------------------ W3 orchestration (live run needs separate approval)

export type W3Outcome =
  | "atomic_rollback_confirmed" // request failed AND both probe objects absent afterwards
  | "partial_persistence" // request failed but a probe object survived — NOT atomic; cleanup proposal applies
  | "not_authorized" // HTTP 401/403 — nothing was executed; no atomicity conclusion
  | "unexpected_success"; // the deliberately failing request reported success — investigate; cleanup proposal applies

export type CanaryW3ProbeReport = {
  readonly target: typeof CANARY_PROJECT_REF;
  readonly outcome: W3Outcome;
  readonly requestFailed: boolean;
  readonly httpStatus: number;
  readonly errorDetail?: string;
  /** True only for atomic_rollback_confirmed. null when no conclusion is possible (not_authorized). */
  readonly atomicRollback: boolean | null;
  /** True when PROPOSED_W3_CLEANUP_SQL must be reviewed and separately approved. */
  readonly cleanupRequired: boolean;
  readonly checks: readonly ProbeCheck[];
};

async function readW3Absence(
  readOnly: CanaryReadOnlyExecutor,
  context: string,
): Promise<{ schemaAbsent: boolean; tableAbsent: boolean }> {
  const rows = await readOnly(SQL_W3_ABSENCE_CHECK, [], context);
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new CanaryProbeError("PROBE_RESULT_MALFORMED", context);
  }
  const r = rows[0] as ProbeRow;
  return { schemaAbsent: r.schema_absent === true, tableAbsent: r.table_absent === true };
}

export async function runCanaryW3Probe(deps: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readOnly: CanaryReadOnlyExecutor;
  readonly probe: CanaryWriteProbeTransport;
}): Promise<CanaryW3ProbeReport> {
  assertCanaryEnvironment(deps.env);
  const checks: ProbeCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  // Preconditions: blank canary AND no probe schema — refuse to send otherwise.
  const baseline = await readBlankFingerprint(deps.readOnly, "w3-baseline");
  add("baseline (read-only): canary is blank", isBlank(baseline), fingerprintDetail(baseline));
  if (!isBlank(baseline)) throw new CanaryProbeError("BASELINE_NOT_BLANK", fingerprintDetail(baseline));
  const before = await readW3Absence(deps.readOnly, "w3-before");
  add("before (read-only): W3 probe schema absent", before.schemaAbsent && before.tableAbsent);
  if (!before.schemaAbsent || !before.tableAbsent) {
    throw new CanaryProbeError("W3_SCHEMA_PRESENT", `schema_absent=${before.schemaAbsent} table_absent=${before.tableAbsent}`);
  }

  // The deliberately failing request. Failure is the EXPECTED outcome.
  const r = await deps.probe.runW3();

  if (r.requestFailed && (r.httpStatus === 401 || r.httpStatus === 403)) {
    const after = await readW3Absence(deps.readOnly, "w3-after-auth");
    add("W3: request authorized", false, `HTTP ${r.httpStatus}: nothing was executed; no atomicity conclusion`);
    add("after (read-only): W3 probe schema absent", after.schemaAbsent && after.tableAbsent);
    return {
      target: CANARY_PROJECT_REF,
      outcome: "not_authorized",
      requestFailed: true,
      httpStatus: r.httpStatus,
      errorDetail: r.errorDetail,
      atomicRollback: null,
      cleanupRequired: !(after.schemaAbsent && after.tableAbsent),
      checks,
    };
  }

  add(
    "W3: deliberately failing request did fail (expected outcome, not yet evidence of atomicity)",
    r.requestFailed,
    `HTTP ${r.httpStatus}${r.errorDetail ? ` ${r.errorDetail}` : ""}`,
  );

  // Only the read-only absence checks decide the result.
  const after = await readW3Absence(deps.readOnly, "w3-after");
  const absent = after.schemaAbsent && after.tableAbsent;
  add("after (read-only): all W3 probe objects absent", absent, `schema_absent=${after.schemaAbsent} table_absent=${after.tableAbsent}`);

  if (!r.requestFailed) {
    return {
      target: CANARY_PROJECT_REF,
      outcome: "unexpected_success",
      requestFailed: false,
      httpStatus: r.httpStatus,
      atomicRollback: false,
      cleanupRequired: !absent,
      checks,
    };
  }

  if (!absent) {
    return {
      target: CANARY_PROJECT_REF,
      outcome: "partial_persistence",
      requestFailed: true,
      httpStatus: r.httpStatus,
      errorDetail: r.errorDetail,
      atomicRollback: false,
      cleanupRequired: true,
      checks,
    };
  }

  // Atomic: additionally re-verify the full blank fingerprint.
  const afterBlank = await readBlankFingerprint(deps.readOnly, "w3-verification");
  add("verification (read-only): canary still blank after W3", isBlank(afterBlank), fingerprintDetail(afterBlank));
  if (!isBlank(afterBlank)) throw new CanaryProbeError("STATE_CHANGED_AFTER_PROBE", fingerprintDetail(afterBlank));

  return {
    target: CANARY_PROJECT_REF,
    outcome: "atomic_rollback_confirmed",
    requestFailed: true,
    httpStatus: r.httpStatus,
    errorDetail: r.errorDetail,
    atomicRollback: true,
    cleanupRequired: false,
    checks,
  };
}

// ------------------------------------------------------------ P1 orchestration (live run needs separate approval)

export type P1Outcome =
  | "sentinel_created" // both requests succeeded and every read-only verification passed
  | "not_authorized"; // HTTP 401/403 on request A — nothing was executed

export type CanaryP1SetupReport = {
  readonly target: typeof CANARY_PROJECT_REF;
  readonly outcome: P1Outcome;
  readonly httpStatusA?: number;
  readonly httpStatusB?: number;
  readonly checks: readonly ProbeCheck[];
};

async function readSentinelPresence(
  readOnly: CanaryReadOnlyExecutor,
  context: string,
): Promise<{ schemaPresent: boolean; tablePresent: boolean }> {
  const rows = await readOnly(SQL_SENTINEL_PRESENCE, [], context);
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new CanaryProbeError("PROBE_RESULT_MALFORMED", context);
  }
  const r = rows[0] as ProbeRow;
  return { schemaPresent: r.schema_present === true, tablePresent: r.table_present === true };
}

/**
 * P1 sequence (stop at the first surprise; NEVER retries, NEVER drops):
 *   token digest from env (no network unless it derives) ->
 *   blank baseline + sentinel absent -> request A -> presence visible ->
 *   ACTUAL ACL/ownership posture verified -> request B ->
 *   authorizeCanaryMutation (the committed gate itself) ->
 *   fingerprint: public untouched, sentinel present.
 */
export async function runCanaryP1SentinelSetup(deps: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readOnly: CanaryReadOnlyExecutor;
  readonly probe: CanaryWriteProbeTransport;
}): Promise<CanaryP1SetupReport> {
  assertCanaryEnvironment(deps.env);
  // Token gate BEFORE any query or request; the digest stays in this scope.
  const digest = deriveSentinelDigestFromEnv(deps.env);

  const checks: ProbeCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });
  add("operator token present, UUID-shaped, not exposed via NEXT_PUBLIC_*; digest derived in process", true);

  // Blank canary AND no sentinel yet.
  const baseline = await readBlankFingerprint(deps.readOnly, "p1-baseline");
  add("baseline (read-only): canary is blank", isBlank(baseline), fingerprintDetail(baseline));
  if (!isBlank(baseline)) throw new CanaryProbeError("BASELINE_NOT_BLANK", fingerprintDetail(baseline));
  const before = await readSentinelPresence(deps.readOnly, "p1-before");
  add("before (read-only): canary_guard absent", !before.schemaPresent && !before.tablePresent);
  if (before.schemaPresent || before.tablePresent) {
    throw new CanaryProbeError("P1_ALREADY_PRESENT", `schema_present=${before.schemaPresent} table_present=${before.tablePresent}`);
  }

  // Request A — the DDL (W3 proved this request shape rolls back atomically on failure).
  const a = await deps.probe.runP1Ddl();
  if (!a.authorized) {
    add("P1 request A authorized", false, `HTTP ${a.httpStatus}: nothing was executed`);
    return { target: CANARY_PROJECT_REF, outcome: "not_authorized", httpStatusA: a.httpStatus, checks };
  }
  add("P1 request A (sentinel DDL) accepted", true, `HTTP ${a.httpStatus}`);

  const presence = await readSentinelPresence(deps.readOnly, "p1-presence");
  add("after A (read-only): schema and table visible", presence.schemaPresent && presence.tablePresent);
  if (!presence.schemaPresent || !presence.tablePresent) {
    throw new CanaryProbeError("P1_DDL_NOT_VISIBLE", `schema_present=${presence.schemaPresent} table_present=${presence.tablePresent}`);
  }

  // ACTUAL posture, not merely that the REVOKEs ran (fail closed on surprises).
  const aclRows = await deps.readOnly(SQL_P1_ACL_CHECK, [], "p1-acl");
  if (aclRows.length !== 1 || typeof aclRows[0] !== "object" || aclRows[0] === null) {
    throw new CanaryProbeError("PROBE_RESULT_MALFORMED", "p1-acl");
  }
  const acl = aclRows[0] as ProbeRow;
  const aclOk =
    acl.anon_schema === false &&
    acl.authenticated_schema === false &&
    acl.service_role_schema === false &&
    acl.anon_table === false &&
    acl.authenticated_table === false &&
    acl.service_role_table === false &&
    acl.schema_owner === EXPECTED_WRITE_PATH_ROLE &&
    acl.table_owner === EXPECTED_WRITE_PATH_ROLE &&
    acl.no_default_acl_in_schema === true;
  add(
    "after A (read-only): no API role holds any privilege; owner postgres; no default ACL in canary_guard",
    aclOk,
    `anon=${String(acl.anon_schema)}/${String(acl.anon_table)} authenticated=${String(acl.authenticated_schema)}/${String(acl.authenticated_table)}` +
      ` service_role=${String(acl.service_role_schema)}/${String(acl.service_role_table)} owner=${String(acl.schema_owner)}/${String(acl.table_owner)}` +
      ` no_default_acl=${String(acl.no_default_acl_in_schema)}`,
  );
  if (!aclOk) throw new CanaryProbeError("P1_ACL_UNEXPECTED");

  // Request B — the parameterized insert (single statement, atomic on its own).
  const b = await deps.probe.runP1Insert(digest);
  add("P1 request B (sentinel insert) accepted", true, `HTTP ${b.httpStatus}`);

  // Verify with the COMMITTED gate itself: one row, id 1, canary ref, digest match.
  const authorization = await authorizeCanaryMutation(deps.readOnly, deps.env);
  add("sentinel verification (read-only): authorizeCanaryMutation eligible", authorization.eligible === true);

  // Final fingerprint: public untouched, no migration rows, sentinel now present.
  const after = await readBlankFingerprint(deps.readOnly, "p1-verification");
  const expected =
    after.publicRelations === 0 &&
    after.publicFunctions === 0 &&
    after.publicTypes === 0 &&
    after.migrationRows === 0 &&
    !after.sentinelSchemaAbsent &&
    after.noPersistedProbeTable;
  add("verification (read-only): public schema untouched; sentinel present", expected, fingerprintDetail(after));
  if (!expected) throw new CanaryProbeError("STATE_CHANGED_AFTER_PROBE", fingerprintDetail(after));

  return { target: CANARY_PROJECT_REF, outcome: "sentinel_created", httpStatusA: a.httpStatus, httpStatusB: b.httpStatus, checks };
}

// ------------------------------------------------------------ P2 orchestration (live run needs separate approval)

export type P2Outcome =
  | "hardened" // the request succeeded and every read-only verification passed
  | "not_authorized"; // HTTP 401/403 — nothing was executed

export type CanaryP2HardeningReport = {
  readonly target: typeof CANARY_PROJECT_REF;
  readonly outcome: P2Outcome;
  readonly httpStatus?: number;
  readonly checks: readonly ProbeCheck[];
};

type AclRow = { owner: string; objtype: string; grantee: string; privilege: string };
const API_ROLES = ["anon", "authenticated", "service_role"] as const;

async function readAclRows(readOnly: CanaryReadOnlyExecutor, sql: string, context: string): Promise<AclRow[]> {
  const rows = await readOnly(sql, [], context);
  return rows.map((r) => {
    if (typeof r !== "object" || r === null) throw new CanaryProbeError("PROBE_RESULT_MALFORMED", context);
    const row = r as ProbeRow;
    if (
      typeof row.owner !== "string" ||
      typeof row.objtype !== "string" ||
      typeof row.grantee !== "string" ||
      typeof row.privilege_type !== "string"
    ) {
      throw new CanaryProbeError("PROBE_RESULT_MALFORMED", context);
    }
    return { owner: row.owner, objtype: row.objtype, grantee: row.grantee, privilege: row.privilege_type };
  });
}

const serializeAcl = (rows: readonly AclRow[]): string =>
  rows
    .map((r) => `${r.owner}|${r.objtype}|${r.grantee}|${r.privilege}`)
    .sort()
    .join("\n");

const apiTableSeqRows = (rows: readonly AclRow[]): AclRow[] =>
  rows.filter(
    (r) => r.owner === EXPECTED_WRITE_PATH_ROLE && (r.objtype === "r" || r.objtype === "S") && (API_ROLES as readonly string[]).includes(r.grantee),
  );

/** Everything P2 must NOT change: postgres function defaults and every non-postgres owner's defaults. */
const outOfScopeRows = (rows: readonly AclRow[]): AclRow[] =>
  rows.filter((r) => r.owner !== EXPECTED_WRITE_PATH_ROLE || r.objtype === "f");

/**
 * P2 sequence (stop at the first surprise; NEVER retries, NEVER rolls back):
 *   sentinel gate (authorizeCanaryMutation) -> public blank + history empty
 *   (sentinel present) -> baseline ACLs: known permissive posture required,
 *   global defaults must be empty, out-of-scope rows snapshotted ->
 *   ONE hardening request -> post ACLs: API table/sequence defaults gone,
 *   global still empty, out-of-scope rows byte-identical, committed
 *   readiness query clean -> sentinel still valid -> fingerprint unchanged.
 */
export async function runCanaryP2Hardening(deps: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readOnly: CanaryReadOnlyExecutor;
  readonly probe: CanaryWriteProbeTransport;
}): Promise<CanaryP2HardeningReport> {
  assertCanaryEnvironment(deps.env);
  const checks: ProbeCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  // Sentinel gate BEFORE any write (throws fixed-message CanaryError codes on failure).
  await authorizeCanaryMutation(deps.readOnly, deps.env);
  add("sentinel gate (read-only): authorizeCanaryMutation eligible", true);

  // Public blank, migration history empty, sentinel present, no probe residue.
  const baseline = await readBlankFingerprint(deps.readOnly, "p2-baseline");
  const baselineOk =
    baseline.publicRelations === 0 &&
    baseline.publicFunctions === 0 &&
    baseline.publicTypes === 0 &&
    baseline.migrationRows === 0 &&
    !baseline.sentinelSchemaAbsent &&
    baseline.noPersistedProbeTable;
  add("baseline (read-only): public blank, history empty, sentinel present", baselineOk, fingerprintDetail(baseline));
  if (!baselineOk) throw new CanaryProbeError("BASELINE_NOT_BLANK", fingerprintDetail(baseline));

  // Baseline ACLs: the permissive posture P2 exists to remove must actually be present,
  // the global scope must be empty, and everything out of scope is snapshotted.
  const preDetail = await readAclRows(deps.readOnly, SQL_P2_ACL_DETAIL, "p2-acl-before");
  const preGlobal = await readAclRows(deps.readOnly, SQL_P2_ACL_GLOBAL, "p2-acl-global-before");
  add("before (read-only): no global default ACLs", preGlobal.length === 0, `global_rows=${preGlobal.length}`);
  if (preGlobal.length !== 0) throw new CanaryProbeError("P2_GLOBAL_ACL_PRESENT", `before: ${preGlobal.length} row(s)`);

  const preApi = apiTableSeqRows(preDetail);
  const permissive = API_ROLES.every(
    (role) => preApi.some((r) => r.objtype === "r" && r.grantee === role) && preApi.some((r) => r.objtype === "S" && r.grantee === role),
  );
  add(
    "before (read-only): known permissive posture present (postgres tables+sequences grant all three API roles)",
    permissive,
    `api_table_seq_rows=${preApi.length}`,
  );
  if (!permissive) throw new CanaryProbeError("P2_BASELINE_ACL_UNEXPECTED", `api_table_seq_rows=${preApi.length}`);
  const outOfScopeBaseline = serializeAcl(outOfScopeRows(preDetail));
  add("before (read-only): out-of-scope defaults snapshotted (postgres functions + non-postgres owners)", true, `rows=${outOfScopeRows(preDetail).length}`);

  // The ONE hardening request.
  const r = await deps.probe.runP2Hardening();
  if (!r.authorized) {
    add("P2 hardening request authorized", false, `HTTP ${r.httpStatus}: nothing was executed`);
    return { target: CANARY_PROJECT_REF, outcome: "not_authorized", httpStatus: r.httpStatus, checks };
  }
  add("P2 hardening request accepted", true, `HTTP ${r.httpStatus}`);

  // Post ACLs.
  const postDetail = await readAclRows(deps.readOnly, SQL_P2_ACL_DETAIL, "p2-acl-after");
  const postGlobal = await readAclRows(deps.readOnly, SQL_P2_ACL_GLOBAL, "p2-acl-global-after");
  const postApi = apiTableSeqRows(postDetail);
  add("after (read-only): no postgres table/sequence default grants to API roles", postApi.length === 0, `api_table_seq_rows=${postApi.length}`);
  if (postApi.length !== 0) throw new CanaryProbeError("P2_HARDENING_INCOMPLETE", `api_table_seq_rows=${postApi.length}`);
  add("after (read-only): global default ACLs still absent", postGlobal.length === 0, `global_rows=${postGlobal.length}`);
  if (postGlobal.length !== 0) throw new CanaryProbeError("P2_GLOBAL_ACL_PRESENT", `after: ${postGlobal.length} row(s)`);
  const outOfScopeUnchanged = serializeAcl(outOfScopeRows(postDetail)) === outOfScopeBaseline;
  add("after (read-only): postgres function defaults and supabase_admin defaults unchanged", outOfScopeUnchanged);
  if (!outOfScopeUnchanged) throw new CanaryProbeError("P2_UNRELATED_ACL_CHANGED");

  // The committed readiness query must now be clean for postgres tables/sequences.
  const readiness = (await deps.readOnly(SQL_DEFAULT_ACL_API_ROLE_GRANTS, [], "p2-readiness")) as ProbeRow[];
  const readinessClean = readiness.every(
    (row) =>
      !(row.owner === EXPECTED_WRITE_PATH_ROLE && (row.objtype === "r" || row.objtype === "S") && String(row.api_role_grantees ?? "") !== ""),
  );
  add("after (read-only): committed A7-equivalence query clean for postgres tables/sequences", readinessClean);
  if (!readinessClean) throw new CanaryProbeError("P2_HARDENING_INCOMPLETE", "committed readiness query");

  // Sentinel untouched; fingerprint unchanged.
  await authorizeCanaryMutation(deps.readOnly, deps.env);
  add("after (read-only): sentinel still valid (authorizeCanaryMutation eligible)", true);
  const after = await readBlankFingerprint(deps.readOnly, "p2-verification");
  const unchanged =
    after.publicRelations === 0 &&
    after.publicFunctions === 0 &&
    after.publicTypes === 0 &&
    after.migrationRows === 0 &&
    !after.sentinelSchemaAbsent &&
    after.noPersistedProbeTable;
  add("verification (read-only): public schema and migration history unchanged; sentinel present", unchanged, fingerprintDetail(after));
  if (!unchanged) throw new CanaryProbeError("STATE_CHANGED_AFTER_PROBE", fingerprintDetail(after));

  return { target: CANARY_PROJECT_REF, outcome: "hardened", httpStatus: r.httpStatus, checks };
}
