// Pydent Phase 2B CANARY migration execution PLAN. NETWORK-FREE. EXECUTES NOTHING.
//
// Builds the ordered, approval-gated plan for bringing the blank canary to the
// full Phase 2B schema: the complete 68-file hash-pinned manifest in the
// reviewed dependency order, preceded by two separately approved proposals
// (the canary sentinel and the privilege hardening). Every phase is marked
// `executes: false`; this module has no transport and no executor.
//
// Transaction handling (see canary-transport.ts for the observed behaviour):
// each migration FILE is planned as one request wrapped in an explicit
// `begin; ... commit;`. That is only planned when a scan of the file's
// top-level statements finds no transaction-control or non-transactional
// statement. The write path (read_only:false) has NOT been observed, so the
// plan also requires a read-only post-step check: if a failed request left
// any partial object behind, the run STOPS and rollback is a project reset.

import type { A7StepId } from "./a7-manifest";
import { CANARY_PROJECT_REF } from "./canary-guard";
import { verifyCanaryManifest, type CanaryManifestReport } from "./canary-manifest-check";
import type { DiskMigration } from "./a7-mutate-lib";
import { PROPOSED_CANARY_SENTINEL_DDL, PROPOSED_CANARY_SENTINEL_INSERT_SQL } from "./canary-sentinel";

// ------------------------------------------------------------ transaction-safety scan

export type TransactionScan = {
  /** True when the file can be wrapped in one explicit transaction. */
  readonly wrapSafe: boolean;
  /** Blocking findings (statement keyword + 1-based top-level statement index). */
  readonly blocking: readonly string[];
  /** Non-blocking cautions worth an operator's attention. */
  readonly cautions: readonly string[];
  readonly statementCount: number;
};

/**
 * Replace comments, quoted strings, quoted identifiers and dollar-quoted
 * bodies with spaces, leaving only top-level SQL keywords and semicolons. A
 * PL/pgSQL `begin` inside `do $$ ... $$` is therefore never mistaken for
 * transaction control.
 */
export function stripSqlLiterals(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth++;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth--;
          i += 2;
        } else i++;
      }
      out += " ";
      continue;
    }
    if (c === "'" ) {
      // E'...' strings allow backslash escapes; standard strings double the quote.
      const escaped = i > 0 && /[eE]/.test(sql[i - 1]) && (i < 2 || !/[A-Za-z0-9_]/.test(sql[i - 2]));
      i++;
      while (i < n) {
        if (escaped && sql[i] === "\\") {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === '"') {
      i++;
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      out += " ";
      continue;
    }
    if (c === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && (i === 0 || !/[A-Za-z0-9_]/.test(sql[i - 1]))) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        i = end === -1 ? n : end + tag.length;
        out += " ";
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

const TX_CONTROL_RE = /^(begin|start\s+transaction|commit|end|rollback|abort|savepoint|release|prepare\s+transaction)\b/i;
const NON_TRANSACTIONAL_RES: readonly [RegExp, string][] = [
  [/\bconcurrently\b/i, "CONCURRENTLY"],
  [/^vacuum\b/i, "VACUUM"],
  [/^(create|drop)\s+database\b/i, "CREATE/DROP DATABASE"],
  [/^alter\s+system\b/i, "ALTER SYSTEM"],
  [/^(create|drop)\s+tablespace\b/i, "CREATE/DROP TABLESPACE"],
  [/^reindex\s+(system|database)\b/i, "REINDEX SYSTEM/DATABASE"],
];

export function scanTransactionSafety(sql: string): TransactionScan {
  const stripped = stripSqlLiterals(sql);
  const statements = stripped
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s !== "");
  const blocking: string[] = [];
  const cautions: string[] = [];
  statements.forEach((s, idx) => {
    const at = `statement ${idx + 1}`;
    if (/\bbegin\s+atomic\b/i.test(s)) blocking.push(`${at}: BEGIN ATOMIC body (statement splitting unreliable; needs manual review)`);
    else if (TX_CONTROL_RE.test(s)) blocking.push(`${at}: transaction control (${s.split(" ")[0].toUpperCase()})`);
    for (const [re, label] of NON_TRANSACTIONAL_RES) if (re.test(s)) blocking.push(`${at}: ${label}`);
    if (/^alter\s+type\b.*\badd\s+value\b/i.test(s)) {
      cautions.push(`${at}: ALTER TYPE ... ADD VALUE (new value unusable later in the same transaction)`);
    }
  });
  return { wrapSafe: blocking.length === 0, blocking, cautions, statementCount: statements.length };
}

/** The exact request text a migration file is planned to be sent as. */
export const wrapInTransaction = (sql: string): string => `begin;\n${sql}\ncommit;\n`;

// ------------------------------------------------------------ privilege hardening (PROPOSED)

/**
 * PROPOSED (not executed) privilege hardening, run BEFORE the baseline so
 * every object the migrations create starts with A7's posture.
 *
 * Evidence for A7's posture (repository only; A7 is never contacted): the
 * reviewed A7 validators assert that anon, authenticated AND service_role
 * hold NO DML on baseline tables (scripts/a7-validate-0066-lib.ts), and 0067
 * exists precisely because A7's default ACLs do not grant service_role DML.
 * No baseline migration grants anything to an API role explicitly, so that
 * posture comes from A7's default privileges. The canary currently has
 * Supabase's permissive defaults (anon/authenticated/service_role get full
 * table, sequence and function privileges on new public objects) — NOT
 * equivalent to A7, and never treated as such by the preflight.
 *
 * Scope: TABLES and SEQUENCES for role postgres in schema public. Function
 * defaults are deliberately NOT changed: A7's function default ACL is not
 * evidenced anywhere in the repository (the Central KB migrations revoke and
 * grant function EXECUTE explicitly). That remains an open question for the
 * operator. Defaults owned by supabase_admin cannot be altered by postgres and
 * are left as they are; the post-baseline check verifies object ownership.
 */
export const PROPOSED_PRIVILEGE_HARDENING_SQL = [
  "begin;",
  "alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated, service_role;",
  "alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated, service_role;",
  "commit;",
].join("\n");

/** Read-only verification for the hardening (and the preflight's A7-equivalence check). */
export const SQL_DEFAULT_ACL_API_ROLE_GRANTS =
  "select d.defaclobjtype::text as objtype, pg_get_userbyid(d.defaclrole) as owner," +
  " coalesce(string_agg(distinct pg_get_userbyid(a.grantee), ',') filter (where pg_get_userbyid(a.grantee) in ('anon','authenticated','service_role')), '') as api_role_grantees" +
  " from pg_default_acl d cross join lateral aclexplode(d.defaclacl) a" +
  " where d.defaclnamespace = 'public'::regnamespace" +
  " group by 1, 2 order by 2, 1";

// ------------------------------------------------------------ read-only post-step markers

/** Fixed read-only marker checks per step (no inputs). Every column must be true. */
export const STEP_MARKER_SQL: Readonly<Record<A7StepId, string>> = {
  "baseline-0001-0064":
    "select to_regclass('public.patients') is not null as m0001," +
    " to_regclass('public.workspaces') is not null as m0014," +
    " to_regclass('public.voice_number_assignments') is not null as m0064",
  "apply-0065":
    "select to_regclass('public.knowledge_resources') is not null as resources," +
    " to_regclass('public.knowledge_documents') is not null as documents," +
    " to_regclass('public.agent_knowledge_resources') is not null as assignments," +
    " to_regprocedure('public.knowledge_apply_document_changes(uuid,uuid,uuid,jsonb,jsonb)') is not null as apply_fn",
  "apply-0067":
    "select has_table_privilege('service_role', 'public.knowledge_resources', 'select,insert,update,delete') as resources_crud," +
    " has_table_privilege('service_role', 'public.knowledge_documents', 'select,insert,update,delete') as documents_crud," +
    " has_table_privilege('service_role', 'public.agent_knowledge_resources', 'select,insert,update,delete') as assignments_crud",
  "apply-0066":
    "select exists (select 1 from information_schema.columns where table_schema = 'public'" +
    " and table_name = 'clinic_settings' and column_name = 'slot_minutes') as slot_minutes",
  "apply-0068":
    "select to_regclass('public.knowledge_chunks') is not null as chunks," +
    " to_regprocedure('public.knowledge_reindex_document(uuid,uuid,text,jsonb)') is not null as reindex_fn," +
    " to_regprocedure('public.knowledge_match_chunks(uuid,uuid,text,integer)') is not null as match_fn",
};

// ------------------------------------------------------------ the plan

export type PlannedRequest = {
  readonly order: number;
  readonly file: string;
  readonly sha256: string;
  readonly wrap: "explicit begin/commit, one request";
  readonly transactionScan: TransactionScan;
};

export type PlanPhase = {
  readonly id: string;
  readonly title: string;
  readonly kind: "read-only" | "write";
  readonly executes: false;
  readonly approvalGate: string;
  readonly stepId?: A7StepId;
  readonly requests: readonly PlannedRequest[];
  readonly proposedSql?: readonly string[];
  readonly postChecks: readonly string[];
  readonly notes: readonly string[];
};

export type CanaryExecutionPlan = {
  readonly ok: boolean;
  readonly target: typeof CANARY_PROJECT_REF;
  readonly manifest: CanaryManifestReport;
  readonly phases: readonly PlanPhase[];
  readonly blockers: readonly string[];
  readonly rollback: readonly string[];
};

export const CANARY_ROLLBACK_STRATEGY: readonly string[] = [
  "Stop at the first failing request: no retry, no next file, no next step.",
  "Each migration file is one request wrapped in begin/commit; the observed no-parameter behaviour suggests a failed request rolls back as a whole, but the write path is UNVERIFIED, so a read-only post-step check must confirm no partial object exists.",
  "Files already committed earlier in a step are NOT rolled back automatically. The canary started blank, so the schema rollback is an operator reset of the canary project (recreate or restore), never an automated DROP ... CASCADE and never a down-migration.",
  "Validation data (future Phase 2B functional step) is removed only by exact run id and exact name, then verified absent against baseline counts.",
  "Nothing in any rollback path may contact production or A7; the same canary guard runs first.",
];

export function buildCanaryExecutionPlan(input: {
  readonly manifestSource: string;
  readonly disk: readonly DiskMigration[];
  readonly readSql: (file: string) => string;
}): CanaryExecutionPlan {
  const manifest = verifyCanaryManifest(input);
  const blockers: string[] = [];
  const phases: PlanPhase[] = [];

  if (!manifest.ok) {
    for (const c of manifest.checks.filter((x) => !x.ok)) blockers.push(`manifest: ${c.name}${c.detail ? ` (${c.detail})` : ""}`);
    return { ok: false, target: CANARY_PROJECT_REF, manifest, phases, blockers, rollback: CANARY_ROLLBACK_STRATEGY };
  }

  phases.push({
    id: "P0",
    title: "Read-only preflight (canary-preflight)",
    kind: "read-only",
    executes: false,
    approvalGate: "already approved for read-only use",
    requests: [],
    postChecks: [
      "session is supabase_read_only_user with transaction_read_only = on",
      "a7_guard absent; canary state is BLANK (0 public objects, 0 migration-history rows)",
      "manifest verification passes",
    ],
    notes: [],
  });

  phases.push({
    id: "P1",
    title: "Create the canary sentinel (PROPOSED — not implemented)",
    kind: "write",
    executes: false,
    approvalGate: "separate approval: write-capable transport + sentinel creation",
    requests: [],
    proposedSql: [PROPOSED_CANARY_SENTINEL_DDL, PROPOSED_CANARY_SENTINEL_INSERT_SQL],
    postChecks: ["authorizeCanaryMutation succeeds (read-only verification)"],
    notes: [
      "Bootstrap write: the only write not gated by the sentinel; gated by its confirmation phrase plus a BLANK preflight.",
      "Two requests: the DDL (no parameters, explicit transaction) then the parameterized insert of the token digest.",
    ],
  });

  phases.push({
    id: "P2",
    title: "Privilege hardening to A7's default-ACL posture (PROPOSED — not implemented)",
    kind: "write",
    executes: false,
    approvalGate: "separate approval: privilege hardening",
    requests: [],
    proposedSql: [PROPOSED_PRIVILEGE_HARDENING_SQL],
    postChecks: ["SQL_DEFAULT_ACL_API_ROLE_GRANTS shows no anon/authenticated/service_role grantee on tables/sequences for owner postgres"],
    notes: [
      "Must run BEFORE the baseline so created objects inherit the hardened defaults.",
      "Function default privileges intentionally unchanged (A7's function defaults are not evidenced in the repository) — open question.",
    ],
  });

  let order = 0;
  manifest.steps.forEach((step, idx) => {
    const requests: PlannedRequest[] = step.migrations.map((m) => {
      const transactionScan = scanTransactionSafety(input.readSql(m.file));
      if (!transactionScan.wrapSafe) blockers.push(`${m.file}: ${transactionScan.blocking.join("; ")}`);
      return { order: ++order, file: m.file, sha256: m.sha256, wrap: "explicit begin/commit, one request", transactionScan };
    });
    phases.push({
      id: `P${3 + idx}`,
      title: `Apply manifest step ${step.stepId} (${requests.length} file${requests.length === 1 ? "" : "s"})`,
      kind: "write",
      executes: false,
      approvalGate: `separate approval: ${step.stepId}`,
      stepId: step.stepId,
      requests,
      postChecks: [
        `STEP_MARKER_SQL["${step.stepId}"] returns all true`,
        "no partial objects from a failed request (read-only fingerprint)",
        ...(step.stepId === "baseline-0001-0064"
          ? ["every public table owned by postgres (hardened defaults applied)", "no public table grants DML to anon/authenticated/service_role (A7 posture)"]
          : []),
      ],
      notes: [
        "Re-verify the full manifest and authorizeCanaryMutation immediately before the step.",
        "One request per file, in order; stop at the first failure.",
      ],
    });
  });

  phases.push({
    id: "P8",
    title: "Read-only post-migration validation (canary-preflight, migrated state)",
    kind: "read-only",
    executes: false,
    approvalGate: "covered by read-only approval",
    requests: [],
    postChecks: [
      "Central KB tables + knowledge_chunks exist with RLS enabled and zero policies",
      "anon/authenticated hold no privilege on them; service_role holds CRUD",
      "Phase 2B functions present",
    ],
    notes: [],
  });

  phases.push({
    id: "P9",
    title: "Phase 2B functional validation (NOT IMPLEMENTED in this build)",
    kind: "write",
    executes: false,
    approvalGate: "separate approval: write-capable transport + temporary validation data",
    requests: [],
    postChecks: ["tests A-D as in the A7 validator; cleanup verified against baseline counts"],
    notes: ["Requires a sentinel-gated mutation transport that does not exist in this build."],
  });

  return { ok: blockers.length === 0, target: CANARY_PROJECT_REF, manifest, phases, blockers, rollback: CANARY_ROLLBACK_STRATEGY };
}
