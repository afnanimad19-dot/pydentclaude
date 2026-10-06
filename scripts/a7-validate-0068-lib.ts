// Pydent A7 — post-0068 READ-ONLY validation logic. NETWORK-FREE module.
//
// Validates, against the catalog of the isolated A7 database, that migration
// 0068_knowledge_chunks.sql produced exactly the approved Phase 2A
// architecture and nothing else:
//   * knowledge_chunks exists with the exact 13 columns (types, nullability,
//     defaults, the generated chars and 'simple'-configured fts columns) and
//     NO Phase 3 vector/embedding columns;
//   * referential integrity is database-enforced: the new composite unique on
//     knowledge_documents (workspace_id, resource_id, id), the chunk FK over
//     all three columns with ON DELETE CASCADE (workspace + resource +
//     owning-document consistency), UNIQUE (document_id, chunk_index), and
//     the size/shape CHECKs (content 1..4000 etc.);
//   * indexes are exactly the approved set (GIN fts + btree
//     (workspace_id, resource_id) + the two constraint indexes) — anything
//     extra is reported as its own failing check, never mutated;
//   * RLS is enabled with ZERO policies; anon/authenticated hold NO table
//     privilege of any kind; PUBLIC holds nothing; service_role holds CRUD;
//   * both RPCs are SECURITY INVOKER with search_path='' and are executable
//     by service_role ONLY;
//   * the STORED definitions (pg_get_functiondef — inspected, NEVER called)
//     prove: reindex locks the document, compares the expected content_hash
//     BEFORE any mutation, returns stale_input without replacement, derives
//     ownership from the locked row, and writes only knowledge_chunks; match
//     builds its candidate set from workspace+agent assignments → resources →
//     ready documents → current-hash chunks BEFORE ranking, uses
//     websearch_to_tsquery('simple'), ts_rank_cd(…, 32), a top-K bound of 20,
//     deterministic ordering, and never uses content_version as authority;
//   * knowledge_chunks holds ZERO rows (Phase 2B has not started).
//
// Fail closed: any mismatch throws A7RunnerError("VALIDATION_FAILED", <checks>).
// The validation SQL is a FIXED read-only SELECT — no inputs, no secrets, no
// DML/DDL, no RPC calls — and the caller must send it with read_only: true
// (the CLI uses createReadOnlyQueryTransport, which hard-codes that).

import { checkA7Config, A7GuardError } from "@/lib/a7-guard";
import type { SentinelQueryExecutor } from "@/lib/a7-sentinel-guard";
import {
  A7_AUTHORIZE_CONFIRMATION_PHRASE,
  runA7AuthorizationProbe,
  A7RunnerError,
} from "./a7-mutate-lib";

/** Expected knowledge_chunks columns, verbatim from 0068 (udt_name based). */
export const EXPECTED_0068_COLUMNS = [
  { name: "chars", udt: "int4", nullable: "YES", generated: true },
  { name: "chunk_index", udt: "int4", nullable: "NO" },
  { name: "content", udt: "text", nullable: "NO" },
  { name: "content_hash", udt: "text", nullable: "NO" },
  { name: "content_version", udt: "int4", nullable: "NO" },
  { name: "created_at", udt: "timestamptz", nullable: "NO", defaultPrefix: "now()" },
  { name: "document_id", udt: "uuid", nullable: "NO" },
  { name: "fts", udt: "tsvector", nullable: "YES", generated: true },
  { name: "heading", udt: "text", nullable: "YES" },
  { name: "id", udt: "uuid", nullable: "NO", defaultPrefix: "gen_random_uuid()" },
  { name: "resource_id", udt: "uuid", nullable: "NO" },
  { name: "source_label", udt: "text", nullable: "NO" },
  { name: "workspace_id", udt: "uuid", nullable: "NO" },
] as const;

const REINDEX_SIG = "public.knowledge_reindex_document(uuid, uuid, text, jsonb)";
const MATCH_SIG = "public.knowledge_match_chunks(uuid, uuid, text, integer)";

/**
 * Fixed, input-free, read-only validation query. Catalog inspection only:
 * information_schema / pg_catalog reads, privilege booleans, the two stored
 * function definitions (inspected as text — the functions are NEVER executed),
 * and one count(*) over knowledge_chunks (expected 0; Phase 2B not started).
 */
export const A7_POST0068_VALIDATION_SQL =
  "select" +
  " to_regclass('public.knowledge_chunks') is not null as table_exists," +
  " (select jsonb_agg(jsonb_build_object('name', column_name, 'udt', udt_name, 'nullable', is_nullable," +
  "    'default', column_default, 'generated', is_generated, 'expr', generation_expression) order by column_name)" +
  "    from information_schema.columns where table_schema = 'public' and table_name = 'knowledge_chunks') as chunk_columns," +
  " (select jsonb_agg(jsonb_build_object('name', conname, 'type', contype::text, 'def', pg_get_constraintdef(oid)) order by conname)" +
  "    from pg_constraint where conrelid = 'public.knowledge_chunks'::regclass) as chunk_constraints," +
  " (select pg_get_constraintdef(oid) from pg_constraint" +
  "    where conname = 'knowledge_documents_ws_res_id_key' and conrelid = 'public.knowledge_documents'::regclass) as docs_unique_def," +
  " (select jsonb_agg(jsonb_build_object('name', indexname, 'def', indexdef) order by indexname)" +
  "    from pg_indexes where schemaname = 'public' and tablename = 'knowledge_chunks') as chunk_indexes," +
  " (select relrowsecurity from pg_class where oid = 'public.knowledge_chunks'::regclass) as rls_enabled," +
  " (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'knowledge_chunks') as policy_count," +
  " has_table_privilege('anon', 'public.knowledge_chunks', 'select,insert,update,delete') as anon_dml," +
  " has_table_privilege('authenticated', 'public.knowledge_chunks', 'select,insert,update,delete') as auth_dml," +
  " has_table_privilege('service_role', 'public.knowledge_chunks', 'select,insert,update,delete') as service_role_dml," +
  " (select coalesce((select bool_or(pg_get_userbyid(a.grantee) in ('anon','authenticated') or a.grantee = 0)" +
  "    from aclexplode(c.relacl) a), false) from pg_class c where c.oid = 'public.knowledge_chunks'::regclass) as browser_or_public_acl," +
  ` has_function_privilege('anon', '${REINDEX_SIG}'::regprocedure, 'execute') as reindex_anon_exec,` +
  ` has_function_privilege('authenticated', '${REINDEX_SIG}'::regprocedure, 'execute') as reindex_auth_exec,` +
  ` has_function_privilege('service_role', '${REINDEX_SIG}'::regprocedure, 'execute') as reindex_service_exec,` +
  ` has_function_privilege('anon', '${MATCH_SIG}'::regprocedure, 'execute') as match_anon_exec,` +
  ` has_function_privilege('authenticated', '${MATCH_SIG}'::regprocedure, 'execute') as match_auth_exec,` +
  ` has_function_privilege('service_role', '${MATCH_SIG}'::regprocedure, 'execute') as match_service_exec,` +
  ` (select jsonb_build_object('secdef', p.prosecdef, 'config', to_jsonb(p.proconfig), 'def', pg_get_functiondef(p.oid))` +
  `    from pg_proc p where p.oid = '${REINDEX_SIG}'::regprocedure) as reindex_fn,` +
  ` (select jsonb_build_object('secdef', p.prosecdef, 'config', to_jsonb(p.proconfig), 'def', pg_get_functiondef(p.oid))` +
  `    from pg_proc p where p.oid = '${MATCH_SIG}'::regprocedure) as match_fn,` +
  " (select count(*)::int from public.knowledge_chunks) as chunk_count";

export type ValidationCheck = { readonly name: string; readonly ok: boolean; readonly detail?: string };

type Row = Record<string, unknown>;
const norm = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").toLowerCase();

/** Evaluate the validation row. Returns the check list; caller fails closed on any false. */
export function evaluatePost0068Row(rows: unknown): ValidationCheck[] {
  if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null) {
    throw new A7RunnerError("VALIDATION_FAILED", "malformed validation result");
  }
  const row = rows[0] as Row;
  const checks: ValidationCheck[] = [];
  const add = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, detail });

  add("knowledge_chunks exists", row.table_exists === true);

  // ---- columns (exact set: names, types, nullability, defaults, generated) --
  const cols = Array.isArray(row.chunk_columns) ? (row.chunk_columns as Row[]) : [];
  add("exactly the 13 approved columns", cols.length === EXPECTED_0068_COLUMNS.length &&
    JSON.stringify(cols.map((c) => c.name)) === JSON.stringify(EXPECTED_0068_COLUMNS.map((c) => c.name)));
  for (const e of EXPECTED_0068_COLUMNS) {
    const a = cols.find((c) => c.name === e.name);
    add(`${e.name}: type ${e.udt}, nullable=${e.nullable}`, a?.udt === e.udt && a?.nullable === e.nullable);
    if ("defaultPrefix" in e && e.defaultPrefix) add(`${e.name}: default ${e.defaultPrefix}`, String(a?.default ?? "").startsWith(e.defaultPrefix));
    if ("generated" in e && e.generated) add(`${e.name}: GENERATED ALWAYS`, a?.generated === "ALWAYS");
  }
  add("chars generated from char_length(content)", norm(cols.find((c) => c.name === "chars")?.expr).includes("char_length(content)"));
  const ftsExpr = norm(cols.find((c) => c.name === "fts")?.expr);
  add("fts uses to_tsvector with the 'simple' configuration over heading + content",
    ftsExpr.includes("to_tsvector") && ftsExpr.includes("'simple'::regconfig") && ftsExpr.includes("heading") && ftsExpr.includes("content"));
  add("no Phase 3 vector columns (embedding / embedding_model / embedding_version)",
    !cols.some((c) => String(c.name).includes("embedding")) && !cols.some((c) => c.udt === "vector"));

  // ---- constraints ----------------------------------------------------------
  const cons = Array.isArray(row.chunk_constraints) ? (row.chunk_constraints as Row[]) : [];
  const def = (name: string) => norm(cons.find((c) => c.name === name)?.def);
  add("UUID primary key", def("knowledge_chunks_pkey") === "primary key (id)");
  add("composite document FK (workspace, resource, document) → knowledge_documents, ON DELETE CASCADE",
    def("knowledge_chunks_document_fk").includes("foreign key (workspace_id, resource_id, document_id) references knowledge_documents(workspace_id, resource_id, id) on delete cascade"));
  add("workspace FK CASCADE", def("knowledge_chunks_workspace_id_fkey").includes("foreign key (workspace_id) references workspaces(id) on delete cascade"));
  add("UNIQUE (document_id, chunk_index)", def("knowledge_chunks_doc_uniq") === "unique (document_id, chunk_index)");
  add("chunk_index >= 0 check", def("knowledge_chunks_index_chk").includes("chunk_index >= 0"));
  add("content 1..4000 check", def("knowledge_chunks_content_chk").includes("char_length(content)") && def("knowledge_chunks_content_chk").includes("4000"));
  add("content_hash nonblank check", def("knowledge_chunks_hash_chk").includes("btrim(content_hash)"));
  add("content_version >= 0 check", def("knowledge_chunks_version_chk").includes("content_version >= 0"));
  add("source_label bounds check", def("knowledge_chunks_label_chk").includes("source_label"));
  add("knowledge_documents UNIQUE (workspace_id, resource_id, id) target", norm(row.docs_unique_def) === "unique (workspace_id, resource_id, id)");

  // ---- indexes (approved set exactly; extras reported, never mutated) -------
  const idx = Array.isArray(row.chunk_indexes) ? (row.chunk_indexes as Row[]) : [];
  const idxDef = (name: string) => norm(idx.find((i) => i.name === name)?.def);
  add("GIN index on fts", idxDef("knowledge_chunks_fts_idx").includes("using gin (fts)"));
  add("btree (workspace_id, resource_id) index", idxDef("knowledge_chunks_ws_resource_idx").includes("(workspace_id, resource_id)"));
  add("constraint indexes present (pkey, doc_uniq)", idx.some((i) => i.name === "knowledge_chunks_pkey") && idx.some((i) => i.name === "knowledge_chunks_doc_uniq"));
  const EXPECTED_IDX = ["knowledge_chunks_doc_uniq", "knowledge_chunks_fts_idx", "knowledge_chunks_pkey", "knowledge_chunks_ws_resource_idx"];
  const extras = idx.map((i) => String(i.name)).filter((n) => !EXPECTED_IDX.includes(n));
  add("no unexpected indexes", extras.length === 0, extras.length ? `unexpected: ${extras.join(", ")}` : undefined);

  // ---- RLS / grants ---------------------------------------------------------
  add("RLS enabled on knowledge_chunks", row.rls_enabled === true);
  add("zero RLS policies", row.policy_count === 0);
  add("anon has no DML", row.anon_dml === false);
  add("authenticated has no DML", row.auth_dml === false);
  add("service_role has CRUD", row.service_role_dml === true);
  add("no ACL entry for anon/authenticated/PUBLIC on knowledge_chunks", row.browser_or_public_acl === false);

  // ---- RPC privileges -------------------------------------------------------
  add("reindex RPC: anon cannot execute", row.reindex_anon_exec === false);
  add("reindex RPC: authenticated cannot execute", row.reindex_auth_exec === false);
  add("reindex RPC: service_role can execute", row.reindex_service_exec === true);
  add("match RPC: anon cannot execute", row.match_anon_exec === false);
  add("match RPC: authenticated cannot execute", row.match_auth_exec === false);
  add("match RPC: service_role can execute", row.match_service_exec === true);

  // ---- stored definitions (INSPECTED, never called) -------------------------
  const fnOf = (v: unknown) => (v && typeof v === "object" ? (v as Row) : {});
  const cfgHas = (v: unknown) => Array.isArray(v) && v.some((s) => String(s).replace(/\s/g, "") === 'search_path=""');
  const reindex = fnOf(row.reindex_fn);
  const rdef = norm(reindex.def);
  add("reindex: SECURITY INVOKER (not definer)", reindex.secdef === false && rdef.includes("security invoker") && !rdef.includes("security definer"));
  add("reindex: fixed empty search_path", cfgHas(reindex.config));
  const lockAt = rdef.indexOf("for update");
  const hashAt = rdef.indexOf("doc.content_hash is distinct from p_content_hash");
  const delAt = rdef.indexOf("delete from public.knowledge_chunks");
  const insAt = rdef.indexOf("insert into public.knowledge_chunks");
  add("reindex: workspace-scoped lock → hash check → delete → insert, in order",
    rdef.includes("d.workspace_id = p_workspace_id") && lockAt > 0 && hashAt > lockAt && delAt > hashAt && insAt > delAt);
  add("reindex: stale input returns without replacement", rdef.includes("'stale_input', true"));
  add("reindex: ownership derived from the locked document row", rdef.includes("doc.workspace_id, doc.resource_id, doc.id"));
  add("reindex: mutates ONLY knowledge_chunks",
    [...rdef.matchAll(/(?:insert into|delete from|update) public\.([a-z_]+)/g)].every((m) => m[1] === "knowledge_chunks"));

  const match = fnOf(row.match_fn);
  const mdef = norm(match.def);
  add("match: SECURITY INVOKER (not definer)", match.secdef === false && mdef.includes("security invoker") && !mdef.includes("security definer"));
  add("match: fixed empty search_path", cfgHas(match.config));
  add("match: candidate set rooted at workspace+agent assignments",
    mdef.includes("from public.agent_knowledge_resources a") && mdef.includes("a.workspace_id = p_workspace_id and a.agent_id = p_agent_id"));
  add("match: ready-document requirement", mdef.includes("d.status = 'ready'"));
  add("match: content_hash authority (chunk = document)", mdef.includes("c.content_hash = d.content_hash"));
  add("match: content_version is NOT an authority predicate", !mdef.includes("content_version"));
  add("match: tenancy before ranking (fts @@ only inside the scoped chain)",
    mdef.indexOf("c.fts @@ tsq") > mdef.indexOf("a.workspace_id = p_workspace_id"));
  add("match: websearch_to_tsquery('simple')", mdef.includes("websearch_to_tsquery('simple'"));
  add("match: ts_rank_cd normalization 32", mdef.includes("ts_rank_cd(c.fts, tsq, 32)"));
  add("match: top-K bounded to 20", mdef.includes("least(coalesce(p_top_k, 8), 20)"));
  add("match: deterministic tie-breaking", mdef.includes("order by score desc, a.position, d.position, c.chunk_index, c.id"));
  add("match: reports the candidate universe (searched_chunks)", mdef.includes("searched_chunks"));
  add("match: never mutates", !/(insert into|delete from|update) public\./.test(mdef));

  // ---- empty state (Phase 2B not started) -----------------------------------
  add("knowledge_chunks holds ZERO rows", row.chunk_count === 0, row.chunk_count === 0 ? undefined : `count=${String(row.chunk_count)}`);

  return checks;
}

export type Post0068ValidationDeps = {
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
export async function runA7Post0068Validation(
  deps: Post0068ValidationDeps,
): Promise<{ ok: true; ref: string; checks: ValidationCheck[] }> {
  const identity = checkA7Config(deps.env);
  if (!identity.ok) throw new A7GuardError(identity.code, identity.reason);

  const probe = await runA7AuthorizationProbe({
    confirmation: deps.confirmation,
    env: deps.env,
    executeSentinelQuery: deps.executeSentinelQuery,
  });

  const rows = await deps.executeReadOnlyQuery(A7_POST0068_VALIDATION_SQL, [], "post-0068-validation");
  const checks = evaluatePost0068Row(rows);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    throw new A7RunnerError("VALIDATION_FAILED", failed.map((c) => c.name).join("; ").slice(0, 300));
  }
  return { ok: true, ref: probe.ref, checks };
}

export { A7_AUTHORIZE_CONFIRMATION_PHRASE };
