// Pydent Phase 2B CANARY read-only preflight — logic. NETWORK-FREE module.
//
// Every query is a FIXED read-only SELECT sent through an injected executor
// (the CLI injects createCanaryReadOnlyTransport, which hard-codes
// read_only: true). The very first query proves the session is the read-only
// role inside a read-only transaction; if it is not, the preflight stops
// before sending anything else.
//
// Two kinds of checks:
//   * REQUIRED — the preflight itself fails (exit 1): wrong/writable session,
//     a7_guard present (this is not the canary), migration-history rows of
//     unknown provenance, validation residue, missing pgcrypto, a broken
//     post-migration contract.
//   * READINESS — the preflight passes but the NEXT write step is blocked:
//     no canary sentinel yet, default privileges not hardened to A7's posture.
//     Permissive defaults are reported as NOT A7-equivalent, never accepted.

import { CANARY_PROJECT_REF, CanaryError, assertCanaryEnvironment } from "./canary-guard";
import type { CanaryReadOnlyExecutor } from "./canary-transport";
import { CANARY_STEP_ORDER } from "./canary-manifest-check";
import { STEP_MARKER_SQL, SQL_DEFAULT_ACL_API_ROLE_GRANTS } from "./canary-plan-lib";
import { SQL_SENTINEL_PRESENCE } from "./canary-sentinel";
import type { A7StepId } from "./a7-manifest";

export const CANARY_PREFLIGHT_CONFIRMATION_PHRASE =
  "I-UNDERSTAND-THIS-CONTACTS-THE-CANARY-DATABASE-READ-ONLY-thqjtoxzkujnljsmkwkp";

export const EXPECTED_READ_ONLY_ROLE = "supabase_read_only_user";
export const CANARY_VALIDATION_MARKER_PREFIX = "CANARY-2B-VALIDATION";
/** The A7 validator's marker; detected (never cleaned) so A7 residue can't be mistaken for canary state. */
export const A7_VALIDATION_MARKER_PREFIX = "A7-2B-VALIDATION";

export const SQL_SESSION =
  "select current_user as role_name, session_user as session_role," +
  " current_setting('transaction_read_only') as transaction_read_only," +
  " current_setting('default_transaction_read_only') as default_transaction_read_only," +
  " current_setting('server_version_num') as server_version_num";

export const SQL_IDENTITY = "select to_regnamespace('a7_guard') is null as a7_guard_absent";

export const SQL_PUBLIC_INVENTORY =
  "select" +
  " (select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public') as relations," +
  " (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public') as functions," +
  " (select count(*)::int from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = 'public' and t.typtype in ('e','c','d')) as types";

export const SQL_HISTORY_TABLE = "select to_regclass('supabase_migrations.schema_migrations') is not null as present";
export const SQL_HISTORY_COUNT = "select count(*)::int as rows from supabase_migrations.schema_migrations";

export const SQL_PGCRYPTO =
  "select exists (select 1 from pg_available_extensions where name = 'pgcrypto') as available," +
  " exists (select 1 from pg_extension where extname = 'pgcrypto') as installed";

export const SQL_RESIDUE =
  "select count(*)::int as residue from public.workspaces where name like $1 or name like $2";

const KB_TABLES = ["knowledge_resources", "knowledge_documents", "agent_knowledge_resources", "knowledge_chunks"] as const;

/** Fixed post-migration contract for the Phase 2B objects (read-only, no inputs). */
export const SQL_POST_MIGRATION_CONTRACT =
  "select c.relname as table_name, c.relrowsecurity as rls," +
  " (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies," +
  " has_table_privilege('anon', c.oid, 'select,insert,update,delete,truncate,references,trigger') as anon_any," +
  " has_table_privilege('authenticated', c.oid, 'select,insert,update,delete,truncate,references,trigger') as authenticated_any," +
  " (has_table_privilege('service_role', c.oid, 'select') and has_table_privilege('service_role', c.oid, 'insert')" +
  "  and has_table_privilege('service_role', c.oid, 'update') and has_table_privilege('service_role', c.oid, 'delete')) as service_role_crud" +
  " from pg_class c join pg_namespace n on n.oid = c.relnamespace" +
  ` where n.nspname = 'public' and c.relname in (${KB_TABLES.map((t) => `'${t}'`).join(", ")})` +
  " order by c.relname";

export type CanaryState = "blank" | "partial" | "migrated";

export type PreflightCheck = {
  readonly name: string;
  readonly ok: boolean;
  readonly kind: "required" | "readiness";
  readonly detail?: string;
};

export type CanaryPreflightReport = {
  readonly target: typeof CANARY_PROJECT_REF;
  /** Every REQUIRED check passed. */
  readonly passed: boolean;
  /** Every check passed — the next write step's preconditions hold. */
  readonly readyForWrites: boolean;
  readonly state: CanaryState;
  /** Last manifest step whose read-only markers are complete, or null. */
  readonly completedThrough: A7StepId | null;
  readonly checks: readonly PreflightCheck[];
};

type Row = Record<string, unknown>;

const one = (rows: unknown[], what: string): Row => {
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) throw new CanaryError("RESULT_MALFORMED", what);
  return rows[0] as Row;
};

const asInt = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : NaN;
};

const allTrue = (row: Row): boolean => Object.values(row).length > 0 && Object.values(row).every((v) => v === true);

export async function runCanaryPreflight(deps: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly executeReadOnlyQuery: CanaryReadOnlyExecutor;
}): Promise<CanaryPreflightReport> {
  // Guard again (the transport already did at construction): no query unless it passes.
  assertCanaryEnvironment(deps.env);
  const q = (sql: string, context: string, params: readonly string[] = []) => deps.executeReadOnlyQuery(sql, params, context);

  const checks: PreflightCheck[] = [];
  const add = (name: string, ok: boolean, kind: PreflightCheck["kind"], detail?: string) => checks.push({ name, ok, kind, detail });

  // 1. Read-only session — stop immediately otherwise.
  const session = one(await q(SQL_SESSION, "session"), "session");
  const readOnly =
    session.role_name === EXPECTED_READ_ONLY_ROLE &&
    session.transaction_read_only === "on" &&
    session.default_transaction_read_only === "on";
  if (!readOnly) throw new CanaryError("PREFLIGHT_NOT_READ_ONLY", `role=${String(session.role_name)}`);
  add("session is the read-only role in a read-only transaction", true, "required", `${EXPECTED_READ_ONLY_ROLE}, pg ${String(session.server_version_num)}`);

  // 2. Identity: the A7 sentinel schema must NOT exist here.
  const identity = one(await q(SQL_IDENTITY, "identity"), "identity");
  add("a7_guard schema absent (this is not the A7 database)", identity.a7_guard_absent === true, "required");

  // 3. Inventory + migration history.
  const inv = one(await q(SQL_PUBLIC_INVENTORY, "public-inventory"), "public-inventory");
  const relations = asInt(inv.relations);
  const functions = asInt(inv.functions);
  const types = asInt(inv.types);
  const historyPresent = one(await q(SQL_HISTORY_TABLE, "history-table"), "history-table").present === true;
  const historyRows = historyPresent ? asInt(one(await q(SQL_HISTORY_COUNT, "history-count"), "history-count").rows) : 0;
  add(
    "migration history has no rows of unknown provenance",
    historyRows === 0,
    "required",
    `schema_migrations ${historyPresent ? `rows=${historyRows}` : "absent"} (canary tooling never writes it)`,
  );

  // 4. Step markers, in dependency order, stopping at the first incomplete step
  //    (later markers may reference objects that do not exist yet).
  let completedThrough: A7StepId | null = null;
  const blank = relations === 0 && functions === 0 && types === 0;
  if (!blank) {
    for (const stepId of CANARY_STEP_ORDER) {
      const row = one(await q(STEP_MARKER_SQL[stepId], `markers-${stepId}`), `markers-${stepId}`);
      if (!allTrue(row)) break;
      completedThrough = stepId;
    }
  }
  const state: CanaryState = blank ? "blank" : completedThrough === CANARY_STEP_ORDER[CANARY_STEP_ORDER.length - 1] ? "migrated" : "partial";
  add(`canary state classified: ${state}`, true, "required", `relations=${relations} functions=${functions} types=${types} completedThrough=${completedThrough ?? "none"}`);

  // 5. pgcrypto (the only extension the migrations create).
  const pg = one(await q(SQL_PGCRYPTO, "pgcrypto"), "pgcrypto");
  add("pgcrypto available", pg.available === true || pg.installed === true, "required", pg.installed === true ? "installed" : "available");

  // 6. Validation residue (only once workspaces exists). Detected, never cleaned.
  if (completedThrough !== null) {
    const residue = asInt(
      one(await q(SQL_RESIDUE, "residue", [`${CANARY_VALIDATION_MARKER_PREFIX} %`, `${A7_VALIDATION_MARKER_PREFIX} %`]), "residue").residue,
    );
    add("no validation residue workspaces", residue === 0, "required", `residue=${residue}`);
  }

  // 7. Post-migration contract for the Phase 2B objects.
  if (state === "migrated") {
    const rows = (await q(SQL_POST_MIGRATION_CONTRACT, "post-migration-contract")) as Row[];
    const byName = new Map(rows.map((r) => [String(r.table_name), r]));
    for (const t of KB_TABLES) {
      const r = byName.get(t);
      add(`${t}: present, RLS enabled, zero policies`, !!r && r.rls === true && asInt(r.policies) === 0, "required");
      add(`${t}: anon/authenticated hold no privilege`, !!r && r.anon_any === false && r.authenticated_any === false, "required");
      add(`${t}: service_role holds CRUD`, !!r && r.service_role_crud === true, "required");
    }
  }

  // 8. Readiness: sentinel + A7-equivalent default privileges.
  const sentinel = one(await q(SQL_SENTINEL_PRESENCE, "sentinel-presence"), "sentinel-presence");
  add("canary sentinel present (required before any write)", sentinel.table_present === true, "readiness", sentinel.schema_present === true ? "schema present" : "schema absent");

  const acl = (await q(SQL_DEFAULT_ACL_API_ROLE_GRANTS, "default-acl")) as Row[];
  const postgresTablesOrSeq = acl.filter(
    (r) => r.owner === "postgres" && (r.objtype === "r" || r.objtype === "S") && String(r.api_role_grantees ?? "") !== "",
  );
  add(
    "default privileges A7-equivalent (no API-role grants on new public tables/sequences for owner postgres)",
    postgresTablesOrSeq.length === 0,
    "readiness",
    postgresTablesOrSeq.length === 0
      ? undefined
      : `NOT A7-equivalent: ${postgresTablesOrSeq.map((r) => `${String(r.objtype)}→${String(r.api_role_grantees)}`).join("; ")} — privilege hardening (plan P2) required`,
  );
  const otherOwners = acl.filter((r) => r.owner !== "postgres" && String(r.api_role_grantees ?? "") !== "");
  if (otherOwners.length > 0) {
    add(
      "non-postgres default privileges noted (not changeable by postgres; migrations must create objects as postgres)",
      true,
      "readiness",
      otherOwners.map((r) => `${String(r.owner)}:${String(r.objtype)}`).join(", "),
    );
  }

  const passed = checks.filter((c) => c.kind === "required").every((c) => c.ok);
  return { target: CANARY_PROJECT_REF, passed, readyForWrites: passed && checks.every((c) => c.ok), state, completedThrough, checks };
}
