// Post-0068 read-only validator — PURE tests. fetch is ALWAYS an injected
// fake; no real network, no database; fixture secrets only. The two 0068
// functions are never executed anywhere in these tests: their STORED
// definitions are fixtures extracted from the migration file itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { A7_PROJECT_REF, A7_SUPABASE_URL, FORBIDDEN_PRODUCTION_REF, A7GuardError } = await import("@/lib/a7-guard");
const { A7SentinelGuardError } = await import("@/lib/a7-sentinel-guard");
const { parseEnvA7, A7RunnerError, A7_AUTHORIZE_CONFIRMATION_PHRASE, A7_LIVE_CONFIRMATION_PHRASE } =
  await import("../scripts/a7-mutate-lib.ts");
const { createReadOnlyQueryTransport, createSentinelReadTransport } = await import("../scripts/a7-live-transport.ts");
const vlib = await import("../scripts/a7-validate-0068-lib.ts");
const { A7_POST0068_VALIDATION_SQL, EXPECTED_0068_COLUMNS, evaluatePost0068Row, runA7Post0068Validation } = vlib;
const { parseValidate0068CliArgs } = await import("../scripts/a7-validate-0068.ts");

const root = path.resolve(import.meta.dirname, "..");
const sha256hex = (s) => createHash("sha256").update(s).digest("hex");
const FAKE_SENTINEL = "11111111-2222-4333-8444-555555555555";
const FAKE_MGMT = "sbp_FAKE_fixture_management_token_000";
const CONFIRM = A7_AUTHORIZE_CONFIRMATION_PHRASE;

// Stored-definition fixtures come from the REAL migration text, so the
// fixtures can never drift from what A7 actually stores structurally — BUT
// with the header adjusted to PostgreSQL's REAL pg_get_functiondef rendering:
// pg_get_functiondef never prints a "SECURITY INVOKER" clause (invoker is the
// unprinted default; only SECURITY DEFINER is ever emitted). The validator's
// first live run on A7 failed exactly because an earlier fixture kept the
// migration's literal "security invoker" line; stripping it here reproduces
// the real representation the transport returns.
const MIGRATION = fs.readFileSync(path.join(root, "supabase", "migrations", "0068_knowledge_chunks.sql"), "utf8");
function fnDef(name) {
  const start = MIGRATION.indexOf(`create or replace function public.${name}(`);
  const end = MIGRATION.indexOf("end $$;", start);
  assert.ok(start >= 0 && end > start, name);
  const text = MIGRATION.slice(start, end + "end $$;".length);
  assert.ok(text.includes("security invoker"), `${name}: the migration itself declares SECURITY INVOKER`);
  // pg_get_functiondef omits the clause for invoker functions.
  return text.replace(/^security invoker\s*$/m, "");
}
const REINDEX_DEF = fnDef("knowledge_reindex_document");
const MATCH_DEF = fnDef("knowledge_match_chunks");

const fakeEnv = () =>
  parseEnvA7(
    [
      "A7_MODE=1",
      `A7_EXPECTED_REF=${A7_PROJECT_REF}`,
      `NEXT_PUBLIC_SUPABASE_URL=${A7_SUPABASE_URL}`,
      `A7_SENTINEL_TOKEN=${FAKE_SENTINEL}`,
      `A7_SUPABASE_MGMT_TOKEN=${FAKE_MGMT}`,
    ].join("\n"),
  );

const col = (name, udt, nullable, extra = {}) => ({ name, udt, nullable, default: null, generated: "NEVER", expr: null, ...extra });

const goodRow = () => ({
  table_exists: true,
  chunk_columns: [
    col("chars", "int4", "YES", { generated: "ALWAYS", expr: "char_length(content)" }),
    col("chunk_index", "int4", "NO"),
    col("content", "text", "NO"),
    col("content_hash", "text", "NO"),
    col("content_version", "int4", "NO"),
    col("created_at", "timestamptz", "NO", { default: "now()" }),
    col("document_id", "uuid", "NO"),
    col("fts", "tsvector", "YES", { generated: "ALWAYS", expr: "to_tsvector('simple'::regconfig, (COALESCE(heading, ''::text) || ' '::text) || content)" }),
    col("heading", "text", "YES"),
    col("id", "uuid", "NO", { default: "gen_random_uuid()" }),
    col("resource_id", "uuid", "NO"),
    col("source_label", "text", "NO"),
    col("workspace_id", "uuid", "NO"),
  ],
  chunk_constraints: [
    { name: "knowledge_chunks_content_chk", type: "c", def: "CHECK (((char_length(content) >= 1) AND (char_length(content) <= 4000)))" },
    { name: "knowledge_chunks_doc_uniq", type: "u", def: "UNIQUE (document_id, chunk_index)" },
    { name: "knowledge_chunks_document_fk", type: "f", def: "FOREIGN KEY (workspace_id, resource_id, document_id) REFERENCES knowledge_documents(workspace_id, resource_id, id) ON DELETE CASCADE" },
    { name: "knowledge_chunks_hash_chk", type: "c", def: "CHECK ((char_length(btrim(content_hash)) > 0))" },
    { name: "knowledge_chunks_index_chk", type: "c", def: "CHECK ((chunk_index >= 0))" },
    { name: "knowledge_chunks_label_chk", type: "c", def: "CHECK (((char_length(btrim(source_label)) >= 1) AND (char_length(btrim(source_label)) <= 200)))" },
    { name: "knowledge_chunks_pkey", type: "p", def: "PRIMARY KEY (id)" },
    { name: "knowledge_chunks_version_chk", type: "c", def: "CHECK ((content_version >= 0))" },
    { name: "knowledge_chunks_workspace_id_fkey", type: "f", def: "FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE" },
  ],
  docs_unique_def: "UNIQUE (workspace_id, resource_id, id)",
  chunk_indexes: [
    { name: "knowledge_chunks_doc_uniq", def: "CREATE UNIQUE INDEX knowledge_chunks_doc_uniq ON public.knowledge_chunks USING btree (document_id, chunk_index)" },
    { name: "knowledge_chunks_fts_idx", def: "CREATE INDEX knowledge_chunks_fts_idx ON public.knowledge_chunks USING gin (fts)" },
    { name: "knowledge_chunks_pkey", def: "CREATE UNIQUE INDEX knowledge_chunks_pkey ON public.knowledge_chunks USING btree (id)" },
    { name: "knowledge_chunks_ws_resource_idx", def: "CREATE INDEX knowledge_chunks_ws_resource_idx ON public.knowledge_chunks USING btree (workspace_id, resource_id)" },
  ],
  rls_enabled: true,
  policy_count: 0,
  anon_dml: false,
  auth_dml: false,
  service_role_dml: true,
  browser_or_public_acl: false,
  reindex_anon_exec: false,
  reindex_auth_exec: false,
  reindex_service_exec: true,
  match_anon_exec: false,
  match_auth_exec: false,
  match_service_exec: true,
  reindex_fn: { secdef: false, config: ['search_path=""'], def: REINDEX_DEF },
  match_fn: { secdef: false, config: ['search_path=""'], def: MATCH_DEF },
  chunk_count: 0,
});

/** Fake endpoint answering the sentinel probe and the validation query. */
const makeFakeEndpoint = ({ dbToken = FAKE_SENTINEL, row = goodRow() } = {}) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body });
    if (body.query.includes("a7_guard.sentinel")) {
      const digest = body.parameters?.[0];
      return { ok: true, status: 201, text: async () => "", json: async () => [{ row_count: 1, id_ok: true, ref_ok: true, token_ok: digest === sha256hex(dbToken.toLowerCase()) }] };
    }
    return { ok: true, status: 201, text: async () => "", json: async () => [row] };
  };
  fetchImpl.requests = requests;
  return fetchImpl;
};

const wireDeps = (fetchImpl, overrides = {}) => {
  const env = overrides.env ?? fakeEnv();
  return {
    confirmation: CONFIRM,
    env,
    executeSentinelQuery: createSentinelReadTransport(fakeEnv(), fetchImpl).executeSentinelQuery,
    executeReadOnlyQuery: createReadOnlyQueryTransport(fakeEnv(), fetchImpl).executeReadOnlyQuery,
    ...overrides,
  };
};

test("happy path: sentinel then validation, every request read_only:true, all checks pass", async () => {
  const fetchImpl = makeFakeEndpoint();
  const result = await runA7Post0068Validation(wireDeps(fetchImpl));
  assert.equal(result.ok, true);
  assert.equal(result.ref, A7_PROJECT_REF);
  assert.ok(result.checks.length >= 45 && result.checks.every((c) => c.ok), JSON.stringify(result.checks.filter((c) => !c.ok)));
  assert.equal(fetchImpl.requests.length, 2, "sentinel + validation only");
  for (const { url, body } of fetchImpl.requests) {
    assert.ok(url.includes(A7_PROJECT_REF) && !url.includes(FORBIDDEN_PRODUCTION_REF));
    assert.equal(body.read_only, true, "every request is read_only:true");
  }
  assert.ok(fetchImpl.requests[0].body.query.includes("a7_guard.sentinel"), "sentinel verification first");
});

test("production target refused BEFORE any network use", async () => {
  const fetchImpl = makeFakeEndpoint();
  await assert.rejects(
    runA7Post0068Validation(wireDeps(fetchImpl, { env: { ...fakeEnv(), NEXT_PUBLIC_SUPABASE_URL: `https://${FORBIDDEN_PRODUCTION_REF}.supabase.co` } })),
    (e) => e instanceof A7GuardError && e.code === "PRODUCTION_TARGET_BLOCKED",
  );
  assert.equal(fetchImpl.requests.length, 0);
});

test("wrong A7 identity / missing mode refused before network", async () => {
  for (const [patch, code] of [
    [{ A7_EXPECTED_REF: "abcdefghij0123456789" }, "EXPECTED_REF_MISMATCH"],
    [{ NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghij0123456789.supabase.co" }, "REF_MISMATCH"],
    [{ A7_MODE: undefined }, "A7_MODE_MISSING"],
  ]) {
    const fetchImpl = makeFakeEndpoint();
    await assert.rejects(
      runA7Post0068Validation(wireDeps(fetchImpl, { env: { ...fakeEnv(), ...patch } })),
      (e) => e instanceof A7GuardError && e.code === code,
      code,
    );
    assert.equal(fetchImpl.requests.length, 0, `${code}: no fetch`);
  }
});

test("absent/wrong confirmation refused pre-network; mutation phrase does not satisfy it", async () => {
  for (const confirmation of [undefined, "", "yes", A7_LIVE_CONFIRMATION_PHRASE]) {
    const fetchImpl = makeFakeEndpoint();
    await assert.rejects(
      runA7Post0068Validation(wireDeps(fetchImpl, { confirmation })),
      (e) => e instanceof A7RunnerError && e.code === "AUTHORIZE_CONFIRMATION_REQUIRED",
      String(confirmation),
    );
    assert.equal(fetchImpl.requests.length, 0);
  }
});

test("sentinel failure stops validation: the validation query is never sent", async () => {
  const fetchImpl = makeFakeEndpoint({ dbToken: "99999999-8888-4777-a666-555555555544" });
  await assert.rejects(
    runA7Post0068Validation(wireDeps(fetchImpl)),
    (e) => e instanceof A7SentinelGuardError && e.code === "SENTINEL_TOKEN_MISMATCH",
  );
  assert.equal(fetchImpl.requests.length, 1, "only the sentinel request ran");
});

test("every architecture mismatch fails closed with the check named", async () => {
  const cases = [
    ["table missing", (r) => { r.table_exists = false; }, "knowledge_chunks exists"],
    ["vector column appeared", (r) => { r.chunk_columns.push(col("embedding", "vector", "YES")); }, "approved columns"],
    ["fts config not simple", (r) => { r.chunk_columns.find((c) => c.name === "fts").expr = "to_tsvector('english'::regconfig, content)"; }, "'simple' configuration"],
    ["chars not generated", (r) => { r.chunk_columns.find((c) => c.name === "chars").generated = "NEVER"; }, "chars: GENERATED"],
    ["content nullable", (r) => { r.chunk_columns.find((c) => c.name === "content").nullable = "YES"; }, "content: type text"],
    ["composite FK gone", (r) => { r.chunk_constraints = r.chunk_constraints.filter((c) => c.name !== "knowledge_chunks_document_fk"); }, "composite document FK"],
    ["FK lost CASCADE", (r) => { r.chunk_constraints.find((c) => c.name === "knowledge_chunks_document_fk").def = "FOREIGN KEY (workspace_id, resource_id, document_id) REFERENCES knowledge_documents(workspace_id, resource_id, id)"; }, "composite document FK"],
    ["doc uniq gone", (r) => { r.chunk_constraints = r.chunk_constraints.filter((c) => c.name !== "knowledge_chunks_doc_uniq"); }, "UNIQUE (document_id, chunk_index)"],
    ["content cap gone", (r) => { r.chunk_constraints.find((c) => c.name === "knowledge_chunks_content_chk").def = "CHECK ((char_length(content) >= 1))"; }, "content 1..4000"],
    ["documents unique target gone", (r) => { r.docs_unique_def = null; }, "UNIQUE (workspace_id, resource_id, id)"],
    ["GIN index gone", (r) => { r.chunk_indexes = r.chunk_indexes.filter((i) => i.name !== "knowledge_chunks_fts_idx"); }, "GIN index"],
    ["unexpected index", (r) => { r.chunk_indexes.push({ name: "sneaky_idx", def: "CREATE INDEX sneaky_idx ON public.knowledge_chunks USING btree (content_hash)" }); }, "no unexpected indexes"],
    ["RLS off", (r) => { r.rls_enabled = false; }, "RLS enabled"],
    ["a policy appeared", (r) => { r.policy_count = 1; }, "zero RLS policies"],
    ["anon gained DML", (r) => { r.anon_dml = true; }, "anon has no DML"],
    ["service_role lost CRUD", (r) => { r.service_role_dml = false; }, "service_role has CRUD"],
    ["browser/PUBLIC acl entry", (r) => { r.browser_or_public_acl = true; }, "no ACL entry"],
    ["anon can call reindex", (r) => { r.reindex_anon_exec = true; }, "reindex RPC: anon"],
    ["authenticated can call match", (r) => { r.match_auth_exec = true; }, "match RPC: authenticated"],
    ["reindex SECURITY DEFINER (secdef=true)", (r) => { r.reindex_fn.secdef = true; }, "reindex: SECURITY INVOKER"],
    ["match SECURITY DEFINER (secdef=true)", (r) => { r.match_fn.secdef = true; }, "match: SECURITY INVOKER"],
    ["reindex definer text despite secdef=false", (r) => { r.reindex_fn.def = `CREATE OR REPLACE FUNCTION public.knowledge_reindex_document(uuid, uuid, text, jsonb)\n SECURITY DEFINER\n${REINDEX_DEF}`; }, "reindex: SECURITY INVOKER"],
    ["match definer text despite secdef=false", (r) => { r.match_fn.def = `CREATE OR REPLACE FUNCTION public.knowledge_match_chunks(uuid, uuid, text, integer)\n SECURITY DEFINER\n${MATCH_DEF}`; }, "match: SECURITY INVOKER"],
    ["reindex secdef as the STRING \"false\"", (r) => { r.reindex_fn.secdef = "false"; }, "reindex: SECURITY INVOKER"],
    ["match secdef as the STRING \"false\"", (r) => { r.match_fn.secdef = "false"; }, "match: SECURITY INVOKER"],
    ["reindex search_path unset", (r) => { r.reindex_fn.config = null; }, "reindex: fixed empty search_path"],
    ["reindex hash check lost", (r) => { r.reindex_fn.def = REINDEX_DEF.replace("doc.content_hash is distinct from p_content_hash", "false"); }, "hash check"],
    ["match hash authority lost", (r) => { r.match_fn.def = MATCH_DEF.replaceAll("c.content_hash = d.content_hash", "true"); }, "content_hash authority"],
    ["match ready filter lost", (r) => { r.match_fn.def = MATCH_DEF.replaceAll("d.status = 'ready'", "true"); }, "ready-document"],
    ["match uses content_version as authority", (r) => { r.match_fn.def = MATCH_DEF.replace("c.content_hash = d.content_hash", "c.content_version = 1 and c.content_hash = d.content_hash"); }, "content_version is NOT"],
    ["match wrong rank normalization", (r) => { r.match_fn.def = MATCH_DEF.replaceAll("ts_rank_cd(c.fts, tsq, 32)", "ts_rank_cd(c.fts, tsq)"); }, "normalization 32"],
    ["match top-K unbounded", (r) => { r.match_fn.def = MATCH_DEF.replace("least(coalesce(p_top_k, 8), 20)", "coalesce(p_top_k, 8)"); }, "top-K bounded"],
    ["chunks already exist", (r) => { r.chunk_count = 5; }, "ZERO rows"],
  ];
  for (const [label, mutate, expectIn] of cases) {
    const row = goodRow();
    mutate(row);
    const fetchImpl = makeFakeEndpoint({ row });
    await assert.rejects(
      runA7Post0068Validation(wireDeps(fetchImpl)),
      (e) => e instanceof A7RunnerError && e.code === "VALIDATION_FAILED" && e.detail.includes(expectIn.split(":")[0]),
      label,
    );
  }
  // malformed result also fails closed
  assert.throws(() => evaluatePost0068Row("garbage"), (e) => e instanceof A7RunnerError && e.code === "VALIDATION_FAILED");
});

test("REGRESSION (live A7 false-failure): real pg_get_functiondef rendering — NO 'SECURITY INVOKER' clause, secdef=false — PASSES for both functions", async () => {
  // Exactly what the Windows run received from A7: prosecdef=false and a
  // definition WITHOUT the literal invoker clause. This must validate.
  const row = goodRow();
  assert.ok(!/security\s+invoker/i.test(String(row.reindex_fn.def)), "fixture models the real rendering (reindex)");
  assert.ok(!/security\s+invoker/i.test(String(row.match_fn.def)), "fixture models the real rendering (match)");
  assert.equal(row.reindex_fn.secdef, false);
  assert.equal(row.match_fn.secdef, false);
  const checks = evaluatePost0068Row([row]);
  for (const name of ["reindex: SECURITY INVOKER (not definer)", "match: SECURITY INVOKER (not definer)"]) {
    const c = checks.find((x) => x.name === name);
    assert.ok(c && c.ok, name);
  }
  const result = await runA7Post0068Validation(wireDeps(makeFakeEndpoint({ row })));
  assert.equal(result.ok, true);
});

test("read-only by construction: fixed SELECT, no DML/DDL, no inputs, functions inspected but never invoked", () => {
  const t = createReadOnlyQueryTransport(fakeEnv(), makeFakeEndpoint());
  assert.deepEqual(Object.keys(t), ["executeReadOnlyQuery"]);
  assert.equal(t.executeMutation, undefined);
  assert.match(A7_POST0068_VALIDATION_SQL, /^select /);
  // Statement forms only — privilege-name literals ('select,insert,update,delete')
  // inside has_table_privilege are arguments, not statements.
  assert.doesNotMatch(
    A7_POST0068_VALIDATION_SQL,
    /\binsert\s+into\b|\bupdate\s+\w+\s+set\b|\bdelete\s+from\b|\bcreate\s|\balter\s|\bdrop\s|\bgrant\s|\brevoke\s|\btruncate\b/i,
  );
  assert.ok(!A7_POST0068_VALIDATION_SQL.includes("$1"), "no bound inputs — nothing injectable");
  // The function names appear ONLY as quoted regprocedure signatures (metadata
  // lookups) — never as calls.
  for (const [name, sig] of [
    ["knowledge_reindex_document", "'public.knowledge_reindex_document(uuid, uuid, text, jsonb)'"],
    ["knowledge_match_chunks", "'public.knowledge_match_chunks(uuid, uuid, text, integer)'"],
  ]) {
    const total = A7_POST0068_VALIDATION_SQL.split(name).length - 1;
    const quoted = A7_POST0068_VALIDATION_SQL.split(sig).length - 1;
    assert.equal(total, quoted, `${name} appears only inside its quoted signature`);
  }
  // Validator source references no mutation symbols (code only, comments/strings stripped).
  for (const file of ["scripts/a7-validate-0068.ts", "scripts/a7-validate-0068-lib.ts"]) {
    const code = fs
      .readFileSync(path.join(root, file), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const forbidden of ["executeMutation", "createLiveTransport", "runLiveStep", "A7_STEPS", "A7_LIVE_CONFIRMATION_PHRASE"]) {
      assert.ok(!code.includes(forbidden), `${file} must not reference ${forbidden}`);
    }
  }
  // Expected-state constants came from the migration file, not guesses.
  for (const c of EXPECTED_0068_COLUMNS) assert.ok(MIGRATION.includes(c.name), c.name);
});

test("validator CLI accepts ONLY --confirm=<exact probe phrase>", () => {
  assert.deepEqual(parseValidate0068CliArgs([`--confirm=${CONFIRM}`]), { confirmation: CONFIRM });
  const refuse = (argv, code) =>
    assert.throws(() => parseValidate0068CliArgs(argv), (e) => e instanceof A7RunnerError && e.code === code, argv.join(" "));
  refuse([], "INVALID_ARGS");
  refuse(["--confirm=wrong"], "AUTHORIZE_CONFIRMATION_REQUIRED");
  refuse([`--confirm=${A7_LIVE_CONFIRMATION_PHRASE}`], "AUTHORIZE_CONFIRMATION_REQUIRED");
  refuse(["apply-0068", `--confirm=${CONFIRM}`], "INVALID_ARGS"); // no step argument exists
  refuse(["--sql=select 1"], "INVALID_ARGS");
  refuse([`--url=https://${FORBIDDEN_PRODUCTION_REF}.supabase.co`], "INVALID_ARGS");
  refuse([`--confirm=${CONFIRM}`, "extra"], "INVALID_ARGS");
});
