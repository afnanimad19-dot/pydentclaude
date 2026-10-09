// Pydent Phase 2B CANARY migration step orchestration — NETWORK-FREE module.
//
// Runs ONE manifest step per invocation against an injected transport, in the
// reviewed dependency order baseline-0001-0064 -> 0065 -> 0067 -> 0066 -> 0068.
// Every gate below refuses before anything is sent, and the run stops at the
// first surprise — no retry, no resume, no rollback path exists here.
//
// MARKERS AND HISTORY: the canary's supabase_migrations.schema_migrations is
// NEVER written (the committed preflight REQUIRES 0 rows). A step's progress
// marker is the set of objects its migrations create, committed atomically in
// the same begin/commit request as the migration itself (atomicity proven by
// the W3 probe), and observed read-only via STEP_MARKER_SQL. There is no
// separate marker request, so there is no two-request atomicity gap.
//
// RECOVERY: a mid-step failure leaves earlier files of that step committed
// (each file is atomic; the step is not). The next invocation detects that
// partial state and REFUSES (P3_STATE_PARTIAL); per the reviewed rollback
// strategy, recovery is an operator decision (normally a canary project
// reset), never an automatic continuation, repair or DROP.

import type { A7StepId } from "./a7-manifest";
import type { DiskMigration } from "./a7-mutate-lib";
import { CANARY_PROJECT_REF, assertCanaryEnvironment } from "./canary-guard";
import { CANARY_STEP_ORDER, assertCanaryManifest, sha256Hex, verifyCanaryManifest, type VerifiedStep } from "./canary-manifest-check";
import { STEP_MARKER_SQL, SQL_DEFAULT_ACL_API_ROLE_GRANTS } from "./canary-plan-lib";
import { SQL_HISTORY_COUNT, SQL_HISTORY_TABLE, SQL_PUBLIC_INVENTORY } from "./canary-preflight-lib";
import { authorizeCanaryMutation } from "./canary-sentinel";
import { CanaryProbeError, EXPECTED_WRITE_PATH_ROLE, type CanaryWriteProbeTransport } from "./canary-probe-lib";
import type { CanaryReadOnlyExecutor } from "./canary-transport";

// ------------------------------------------------------------ errors

export type CanaryMigrateFailureCode =
  | "P3_STEP_UNKNOWN" // the requested step id is not in the reviewed order
  | "P3_PREDECESSOR_INCOMPLETE" // an earlier step's markers are not all true; refusing out-of-order execution
  | "P3_STEP_ALREADY_APPLIED" // the target step's markers are already all true; refusing duplicate application
  | "P3_STATE_PARTIAL" // objects exist but the markers are incomplete — a prior run was interrupted
  | "P3_HISTORY_NOT_EMPTY" // supabase_migrations has rows; this tooling never writes it and refuses to run beside rows it cannot explain
  | "P3_ACL_NOT_HARDENED" // the P2 posture is not in place; migrations would inherit permissive defaults
  | "P3_FILE_HASH_MISMATCH" // a file on disk no longer hashes to its pinned manifest value
  | "P3_POSTCHECK_FAILED" // the step's read-only markers or invariants did not hold after execution
  | "P3_RESULT_MALFORMED"; // a read-only verification returned something uninterpretable

const MIGRATE_MESSAGES: Record<CanaryMigrateFailureCode, string> = {
  P3_STEP_UNKNOWN: "the requested step is not one of the five reviewed manifest steps",
  P3_PREDECESSOR_INCOMPLETE: "an earlier manifest step is not complete; steps only run in the reviewed order",
  P3_STEP_ALREADY_APPLIED: "the target step's markers are already satisfied; refusing a duplicate application",
  P3_STATE_PARTIAL: "the canary holds partial state from an interrupted run; operator decision required (no automatic repair)",
  P3_HISTORY_NOT_EMPTY: "supabase_migrations.schema_migrations has rows; this tooling never writes it and stops",
  P3_ACL_NOT_HARDENED: "default privileges are not the P2-hardened posture; migrations would inherit permissive grants",
  P3_FILE_HASH_MISMATCH: "a migration file does not hash to its pinned manifest value; nothing was sent for it",
  P3_POSTCHECK_FAILED: "a post-step read-only verification failed; stopping",
  P3_RESULT_MALFORMED: "a read-only verification returned a result this tooling cannot interpret; stopping",
};

export class CanaryMigrateError extends Error {
  readonly code: CanaryMigrateFailureCode;
  /** File names / check names / counts ONLY — never SQL contents or secrets. */
  readonly detail?: string;
  constructor(code: CanaryMigrateFailureCode, detail?: string) {
    super(`CANARY MIGRATION STOPPED [${code}]: ${MIGRATE_MESSAGES[code]}${detail ? ` (${detail})` : ""}`);
    this.name = "CanaryMigrateError";
    this.code = code;
    this.detail = detail;
  }
}

// ------------------------------------------------------------ read-only helpers

type Row = Record<string, unknown>;

const oneRow = async (readOnly: CanaryReadOnlyExecutor, sql: string, context: string, params: readonly string[] = []): Promise<Row> => {
  const rows = await readOnly(sql, params, context);
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) throw new CanaryMigrateError("P3_RESULT_MALFORMED", context);
  return rows[0] as Row;
};

const asInt = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
};

const allTrue = (row: Row): boolean => Object.values(row).length > 0 && Object.values(row).every((v) => v === true);
const someTrue = (row: Row): boolean => Object.values(row).some((v) => v === true);

/** Fixed read-only checks the baseline step must additionally satisfy afterwards. */
export const SQL_P3_PUBLIC_OWNERSHIP =
  "select count(*)::int as not_postgres from pg_class c join pg_namespace n on n.oid = c.relnamespace" +
  " where n.nspname = 'public' and c.relkind in ('r', 'p', 'S', 'v', 'm')" +
  ` and pg_get_userbyid(c.relowner) <> '${EXPECTED_WRITE_PATH_ROLE}'`;

export const SQL_P3_PUBLIC_API_GRANTS =
  "select count(*)::int as grants from information_schema.role_table_grants" +
  " where table_schema = 'public' and grantee in ('anon', 'authenticated', 'service_role')";

async function assertAclHardened(readOnly: CanaryReadOnlyExecutor, context: string): Promise<void> {
  const rows = (await readOnly(SQL_DEFAULT_ACL_API_ROLE_GRANTS, [], context)) as Row[];
  const dirty = rows.filter(
    (r) => r.owner === EXPECTED_WRITE_PATH_ROLE && (r.objtype === "r" || r.objtype === "S") && String(r.api_role_grantees ?? "") !== "",
  );
  if (dirty.length !== 0) throw new CanaryMigrateError("P3_ACL_NOT_HARDENED", `rows=${dirty.length}`);
}

async function assertHistoryEmpty(readOnly: CanaryReadOnlyExecutor, context: string): Promise<void> {
  const present = (await oneRow(readOnly, SQL_HISTORY_TABLE, context)).present === true;
  if (!present) return;
  const rows = asInt((await oneRow(readOnly, SQL_HISTORY_COUNT, context)).rows);
  if (rows !== 0) throw new CanaryMigrateError("P3_HISTORY_NOT_EMPTY", `rows=${rows}`);
}

// ------------------------------------------------------------ orchestration

export type MigrateCheck = { readonly name: string; readonly ok: boolean; readonly detail?: string };

export type CanaryMigrationStepReport = {
  readonly target: typeof CANARY_PROJECT_REF;
  readonly stepId: A7StepId;
  readonly outcome: "step_applied" | "not_authorized" | "failed";
  /** Files whose requests were ACCEPTED by the endpoint, in order. */
  readonly filesApplied: readonly string[];
  /** Set when outcome is "failed": the file whose request failed. */
  readonly failedAtFile?: string;
  /** Set when outcome is "failed": the scrubbed transport error message. */
  readonly failureDetail?: string;
  readonly checks: readonly MigrateCheck[];
};

/**
 * Apply ONE manifest step. Gates, in order, each refusing before anything is
 * sent: environment guard; full manifest verification (source hash, order,
 * closed world); sentinel authorization; P2-hardened ACL posture; empty
 * migration history; every predecessor step's markers all true; the target
 * step's markers not already satisfied, with partial state refused. Then one
 * request per file in manifest order, each file's hash re-verified against
 * the pinned manifest immediately before sending. Afterwards: target markers
 * all true, history still empty, ACLs still hardened, sentinel still valid,
 * plus ownership/no-grant checks after the baseline step.
 */
export async function runCanaryMigrationStep(deps: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly readOnly: CanaryReadOnlyExecutor;
  readonly probe: CanaryWriteProbeTransport;
  readonly stepId: string;
  readonly manifestSource: string;
  readonly disk: readonly DiskMigration[];
  readonly readSql: (file: string) => string;
}): Promise<CanaryMigrationStepReport> {
  assertCanaryEnvironment(deps.env);
  const checks: MigrateCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  // The step must be one of the five reviewed ids, and the WHOLE manifest must verify.
  const stepIndex = CANARY_STEP_ORDER.indexOf(deps.stepId as A7StepId);
  if (stepIndex === -1) throw new CanaryMigrateError("P3_STEP_UNKNOWN", deps.stepId);
  const stepId = deps.stepId as A7StepId;
  const manifest = verifyCanaryManifest({ manifestSource: deps.manifestSource, disk: deps.disk, readSql: deps.readSql });
  assertCanaryManifest(manifest);
  const step = manifest.steps.find((s) => s.stepId === stepId) as VerifiedStep;
  add(`manifest verified; step ${stepId} holds ${step.migrations.length} pinned file(s)`, true);

  // Sentinel, hardened ACLs, empty history.
  await authorizeCanaryMutation(deps.readOnly, deps.env);
  add("sentinel gate (read-only): authorizeCanaryMutation eligible", true);
  await assertAclHardened(deps.readOnly, "p3-acl-before");
  add("default privileges are the P2-hardened posture", true);
  await assertHistoryEmpty(deps.readOnly, "p3-history-before");
  add("migration history is empty (this tooling never writes it)", true);

  // Order: every predecessor complete, target not applied, no partial state.
  for (const prior of CANARY_STEP_ORDER.slice(0, stepIndex)) {
    const row = await oneRow(deps.readOnly, STEP_MARKER_SQL[prior], `p3-markers-${prior}`);
    if (!allTrue(row)) throw new CanaryMigrateError("P3_PREDECESSOR_INCOMPLETE", prior);
  }
  add(stepIndex === 0 ? "no predecessor steps required" : `all ${stepIndex} predecessor step(s) complete`, true);

  const targetBefore = await oneRow(deps.readOnly, STEP_MARKER_SQL[stepId], `p3-markers-${stepId}`);
  if (allTrue(targetBefore)) throw new CanaryMigrateError("P3_STEP_ALREADY_APPLIED", stepId);
  if (someTrue(targetBefore)) throw new CanaryMigrateError("P3_STATE_PARTIAL", `${stepId}: markers partially satisfied`);
  if (stepIndex === 0) {
    const inv = await oneRow(deps.readOnly, SQL_PUBLIC_INVENTORY, "p3-inventory");
    const blank = asInt(inv.relations) === 0 && asInt(inv.functions) === 0 && asInt(inv.types) === 0;
    if (!blank) {
      throw new CanaryMigrateError("P3_STATE_PARTIAL", `baseline target but public not blank: relations=${asInt(inv.relations)}`);
    }
    add("public schema is blank before the baseline", true);
  }
  add(`step ${stepId} not yet applied; state consistent`, true);

  // One request per file, manifest order, hash re-verified immediately before each send.
  const filesApplied: string[] = [];
  for (const m of step.migrations) {
    const raw = deps.readSql(m.file);
    if (sha256Hex(raw) !== m.sha256) throw new CanaryMigrateError("P3_FILE_HASH_MISMATCH", m.file);
    let result: Awaited<ReturnType<CanaryWriteProbeTransport["runManifestMigration"]>>;
    try {
      result = await deps.probe.runManifestMigration(raw, m.file, m.sha256);
    } catch (e) {
      // STOP at the failing file; capture read-only state for the report, then
      // hand the operator the facts. No retry, no next file, no repair.
      const failureDetail = e instanceof CanaryProbeError ? e.message : "unexpected transport failure";
      add(`request for ${m.file} failed; run stopped`, false, `${filesApplied.length} earlier file(s) of this step are committed`);
      try {
        const inv = await oneRow(deps.readOnly, SQL_PUBLIC_INVENTORY, "p3-failure-inventory");
        add(
          "state captured (read-only) after failure",
          true,
          `relations=${asInt(inv.relations)} functions=${asInt(inv.functions)} types=${asInt(inv.types)}`,
        );
      } catch {
        add("state capture (read-only) after failure", false, "state query itself failed");
      }
      return { target: CANARY_PROJECT_REF, stepId, outcome: "failed", filesApplied, failedAtFile: m.file, failureDetail, checks };
    }
    if (!result.authorized) {
      add(`request for ${m.file} not authorized`, false, `HTTP ${result.httpStatus}: nothing was executed for it`);
      return { target: CANARY_PROJECT_REF, stepId, outcome: "not_authorized", filesApplied, failedAtFile: m.file, checks };
    }
    filesApplied.push(m.file);
  }
  add(`all ${filesApplied.length} file(s) accepted, one request each, manifest order`, true);

  // Post-step verification.
  const targetAfter = await oneRow(deps.readOnly, STEP_MARKER_SQL[stepId], `p3-markers-after-${stepId}`);
  if (!allTrue(targetAfter)) throw new CanaryMigrateError("P3_POSTCHECK_FAILED", `${stepId}: markers incomplete after execution`);
  add(`step markers for ${stepId} all true`, true);
  await assertHistoryEmpty(deps.readOnly, "p3-history-after");
  add("migration history still empty", true);
  await assertAclHardened(deps.readOnly, "p3-acl-after");
  add("default privileges still the P2-hardened posture", true);
  if (stepIndex === 0) {
    const own = asInt((await oneRow(deps.readOnly, SQL_P3_PUBLIC_OWNERSHIP, "p3-ownership")).not_postgres);
    if (own !== 0) throw new CanaryMigrateError("P3_POSTCHECK_FAILED", `public objects not owned by postgres: ${own}`);
    add("every public relation is owned by postgres", true);
    const grants = asInt((await oneRow(deps.readOnly, SQL_P3_PUBLIC_API_GRANTS, "p3-grants")).grants);
    if (grants !== 0) throw new CanaryMigrateError("P3_POSTCHECK_FAILED", `API-role table grants after baseline: ${grants}`);
    add("no API-role table grants exist after the baseline (A7 posture)", true);
  }
  await authorizeCanaryMutation(deps.readOnly, deps.env);
  add("sentinel still valid (authorizeCanaryMutation eligible)", true);

  return { target: CANARY_PROJECT_REF, stepId, outcome: "step_applied", filesApplied, checks };
}
