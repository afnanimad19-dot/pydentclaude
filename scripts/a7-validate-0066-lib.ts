// Pydent A7 — post-0066 READ-ONLY validation logic. NETWORK-FREE module.
//
// Validates, against the catalog of the isolated A7 database, that migration
// 0066_clinic_scheduling.sql produced exactly its intended effect and nothing
// else, measured against the PRE-0066 security model established by the
// committed migration history (not guessed):
//   * 0025_clinic_settings.sql: table created WITH workspace_id (its PK),
//     RLS ENABLED, one open policy "demo open access".
//   * 0050_workspace_rls.sql: its dynamic loop replaces every qual='true'
//     policy on tables having a workspace_id column — clinic_settings
//     qualifies — with "workspace isolation" (FOR ALL,
//     using/with check (workspace_id = current_workspace())). So the table
//     enters 0066 with exactly that one policy (0027/0042/0046 add columns
//     only and change no policies).
//   * In A7, the API roles (anon/authenticated/service_role) hold NO DML on
//     clinic_settings (the known, deliberately DEFERRED baseline ACL posture).
//     0066 adds columns only, so that posture must be UNCHANGED — this
//     validator asserts it and must never repair it.
//
// Fail closed: any mismatch throws A7RunnerError("VALIDATION_FAILED", <check>).
// The validation SQL is a FIXED read-only SELECT — no inputs, no secrets, no
// digests — and the caller must send it with read_only: true (the CLI uses
// createReadOnlyQueryTransport, which hard-codes that).

import { checkA7Config, A7GuardError } from "@/lib/a7-guard";
import type { SentinelQueryExecutor } from "@/lib/a7-sentinel-guard";
import {
  A7_AUTHORIZE_CONFIRMATION_PHRASE,
  runA7AuthorizationProbe,
  A7RunnerError,
} from "./a7-mutate-lib";

/** Expected 0066 columns, verbatim from 0066_clinic_scheduling.sql. */
export const EXPECTED_0066_COLUMNS = [
  { name: "closed_days", type: "text", default: "''::text" },
  { name: "close_time", type: "text", default: "'17:00'::text" },
  { name: "default_duration_min", type: "integer", default: "30" },
  { name: "open_time", type: "text", default: "'09:00'::text" },
  { name: "slot_minutes", type: "integer", default: "30" },
] as const;

/** Fixed, input-free, read-only validation query. */
export const A7_POST0066_VALIDATION_SQL =
  "select" +
  " to_regclass('public.clinic_settings') is not null as table_exists," +
  " (select jsonb_agg(jsonb_build_object('name', column_name, 'type', data_type, 'default', column_default) order by column_name)" +
  "    from information_schema.columns where table_schema = 'public' and table_name = 'clinic_settings'" +
  "    and column_name in ('open_time','close_time','slot_minutes','default_duration_min','closed_days')) as cols_0066," +
  " (select relrowsecurity from pg_class where oid = 'public.clinic_settings'::regclass) as rls_enabled," +
  " (select coalesce(jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'qual', qual, 'check', with_check) order by policyname), '[]'::jsonb)" +
  "    from pg_policies where schemaname = 'public' and tablename = 'clinic_settings') as policies," +
  " (select pg_get_userbyid(relowner) from pg_class where oid = 'public.clinic_settings'::regclass) as owner," +
  " has_table_privilege('anon', 'public.clinic_settings', 'select,insert,update,delete') as anon_any_dml," +
  " has_table_privilege('authenticated', 'public.clinic_settings', 'select,insert,update,delete') as auth_any_dml," +
  " has_table_privilege('service_role', 'public.clinic_settings', 'select,insert,update,delete') as service_role_any_dml";

export type ValidationCheck = { readonly name: string; readonly ok: boolean };

/** Evaluate the validation row. Returns the check list; caller fails closed on any false. */
export function evaluatePost0066Row(rows: unknown): ValidationCheck[] {
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new A7RunnerError("VALIDATION_FAILED", "malformed validation result");
  }
  const row = rows[0] as Record<string, unknown>;
  const checks: ValidationCheck[] = [];
  const add = (name: string, ok: boolean) => checks.push({ name, ok });

  add("clinic_settings exists", row.table_exists === true);

  const cols = Array.isArray(row.cols_0066) ? (row.cols_0066 as Array<Record<string, unknown>>) : [];
  add("all five 0066 columns present", cols.length === EXPECTED_0066_COLUMNS.length);
  for (const expected of EXPECTED_0066_COLUMNS) {
    const actual = cols.find((c) => c.name === expected.name);
    add(`${expected.name}: type ${expected.type}`, actual?.type === expected.type);
    add(`${expected.name}: default ${expected.default}`, actual?.default === expected.default);
  }

  add("RLS enabled (unchanged from 0025)", row.rls_enabled === true);

  const policies = Array.isArray(row.policies) ? (row.policies as Array<Record<string, unknown>>) : [];
  // Exact pg_policies rendering of the policy 0050 created (0025's "demo open
  // access" was replaced by 0050's dynamic loop — see header).
  add(
    'policies: exactly the pre-0066 "workspace isolation" (ALL, workspace-scoped qual and check)',
    policies.length === 1 &&
      policies[0].name === "workspace isolation" &&
      policies[0].cmd === "ALL" &&
      policies[0].qual === "(workspace_id = current_workspace())" &&
      policies[0].check === "(workspace_id = current_workspace())",
  );

  add("owner is postgres (unchanged)", row.owner === "postgres");
  // The deferred A7 ACL posture must be UNCHANGED by 0066: no API role gained
  // (or lost differently) DML here. This validator never repairs it.
  add("anon has no DML (unchanged)", row.anon_any_dml === false);
  add("authenticated has no DML (unchanged)", row.auth_any_dml === false);
  add("service_role DML posture unchanged by 0066 (none)", row.service_role_any_dml === false);

  return checks;
}

export type Post0066ValidationDeps = {
  /** Must be exactly A7_AUTHORIZE_CONFIRMATION_PHRASE (read-only contact class). */
  readonly confirmation: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Read-only sentinel verification transport (A7-pinned). */
  readonly executeSentinelQuery: SentinelQueryExecutor;
  /** Read-only validation transport (A7-pinned, read_only hard-coded). */
  readonly executeReadOnlyQuery: (sql: string, parameters: readonly string[], context: string) => Promise<unknown>;
};

/**
 * Enforced order: exact probe confirmation -> checkA7Config (production
 * blocked BEFORE any network) -> sentinel authorization (one read-only query)
 * -> the fixed validation query -> evaluation, failing closed on any mismatch.
 * No mutation capability exists anywhere in these dependencies.
 */
export async function runA7Post0066Validation(
  deps: Post0066ValidationDeps,
): Promise<{ ok: true; ref: string; checks: ValidationCheck[] }> {
  // Identity is re-checked here as well so a bad env refuses even before the
  // probe's own identical check (defense in depth; both are pre-network).
  const identity = checkA7Config(deps.env);
  if (!identity.ok) throw new A7GuardError(identity.code, identity.reason);

  const probe = await runA7AuthorizationProbe({
    confirmation: deps.confirmation,
    env: deps.env,
    executeSentinelQuery: deps.executeSentinelQuery,
  });

  const rows = await deps.executeReadOnlyQuery(A7_POST0066_VALIDATION_SQL, [], "post-0066-validation");
  const checks = evaluatePost0066Row(rows);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new A7RunnerError("VALIDATION_FAILED", failed.map((c) => c.name).join("; ").slice(0, 200));
  }
  return { ok: true, ref: probe.ref, checks };
}

export { A7_AUTHORIZE_CONFIRMATION_PHRASE };
