// Pydent Phase 2B CANARY write-capability probe — W1/W2 ONLY. FAILS CLOSED.
//
// AUTHORIZED SCOPE (operator approval, 2026-10-08): exactly two probe
// requests against the pinned canary endpoint, sent with read_only: false.
//   W1 — SELECT-only identity and transaction-state introspection.
//   W2 — temporary table inside an explicit transaction, one test row,
//        ROLLBACK, in-session verification that the temp table is gone.
//   W3 — failure-atomicity probe (IMPLEMENTED OFFLINE ONLY; live execution
//        requires its own separate approval): a deliberately failing
//        multi-statement request in the dedicated canary_probe_w3_atomicity
//        schema, judged solely by read-only absence checks afterwards. Its
//        cleanup is a reviewed PROPOSAL that no code path can execute.
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
  assertCanaryEndpoint,
  assertCanaryEnvironment,
  assertNoForbiddenRef,
  scrubCanaryText,
} from "./canary-guard";
import type { CanaryFetchLike, CanaryReadOnlyExecutor } from "./canary-transport";

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
  | "W3_CLEANUP_NOT_AUTHORIZED"; // the W3 cleanup is a reviewed proposal; executing it is a separate approval

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

// ------------------------------------------------------------ probe transport (W1/W2 only)

type ProbeRow = Record<string, unknown>;

export type CanaryWriteProbeTransport = {
  /** HTTP 401/403 resolves authorized:false; any other failure throws. */
  readonly runW1: () => Promise<{ authorized: boolean; row?: ProbeRow; httpStatus?: number }>;
  readonly runW2: () => Promise<ProbeRow>;
  /** W3 EXPECTS the request to fail; every HTTP outcome resolves (never throws on status). */
  readonly runW3: () => Promise<{ requestFailed: boolean; httpStatus: number; errorDetail?: string }>;
};

const ALLOWLISTED_PROBE_SQL: readonly string[] = Object.freeze([CANARY_PROBE_W1_SQL, CANARY_PROBE_W2_SQL, CANARY_PROBE_W3_SQL]);

export function createCanaryWriteProbeTransport(
  env: Readonly<Record<string, string | undefined>>,
  fetchImpl?: CanaryFetchLike,
): CanaryWriteProbeTransport {
  // Fail closed at construction, exactly like the read-only transport.
  assertCanaryEnvironment(env);
  assertCanaryEndpoint(CANARY_QUERY_ENDPOINT);
  const doFetch: CanaryFetchLike = fetchImpl ?? (globalThis.fetch as unknown as CanaryFetchLike);

  const send = async (sql: string, context: string) => {
    if (!ALLOWLISTED_PROBE_SQL.includes(sql)) throw new CanaryProbeError("PROBE_SQL_NOT_ALLOWLISTED", context);
    assertNoForbiddenRef(sql, `${context}: sql`);
    const url = CANARY_QUERY_ENDPOINT;
    assertCanaryEndpoint(url); // re-checked immediately before every request

    let response: Awaited<ReturnType<CanaryFetchLike>>;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql, read_only: false }),
        redirect: "error",
      });
    } catch {
      throw new CanaryProbeError("PROBE_HTTP_ERROR", `${context}: network failure`);
    }
    return response;
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

  return Object.freeze({ runW1, runW2, runW3 });
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
