// Static checks for migration 0068 (persisted Central Knowledge chunks + FTS,
// Phase 2A) and its A7 preparation (the pinned apply-0068 step). The migration
// is NOT applied by these tests — they read the SQL text only, and the runner
// checks are fully mocked (zero network, zero database). Static checks are NOT
// a substitute for the later A7 gate chain (pre-review → hash-pinned dry-run →
// explicit A7 apply → post-0068 read-only validation).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const { A7_STEPS, runDryRun, validateStepManifest } = await import("../scripts/a7-mutate-lib.ts");

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "supabase", "migrations");
const FILE = "0068_knowledge_chunks.sql";
const raw = fs.readFileSync(path.join(dir, FILE), "utf8");
// Strip comments so prose can never satisfy (or trip) a check.
const normalize = (text) => text.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
const sql = normalize(raw);
// DDL outside function bodies ($$ … $$): where "additive only" is judged.
const ddl = sql.replace(/\$\$[\s\S]*?\$\$/g, "$$ $$");

const REINDEX = { name: "knowledge_reindex_document", sig: "(uuid, uuid, text, jsonb)" };
const MATCH = { name: "knowledge_match_chunks", sig: "(uuid, uuid, text, integer)" };

/** Header (signature … first `$$`) and body of a function in normalized SQL. */
function fn(name) {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `function ${name}`);
  const open = sql.indexOf("$$", start);
  const close = sql.indexOf("$$", open + 2);
  assert.ok(open > start && close > open, `${name} body`);
  return { header: sql.slice(start, open), body: sql.slice(open + 2, close) };
}

function tableBody(name) {
  const start = sql.indexOf(`create table if not exists public.${name} (`);
  assert.ok(start >= 0, `create table ${name}`);
  let depth = 0;
  for (let i = sql.indexOf("(", start); i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0) return sql.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

const realDisk = () =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => ({ file, sha256: createHash("sha256").update(fs.readFileSync(path.join(dir, file))).digest("hex") }));

// ------------------------------------------------------------ schema (1–9)

test("(1,2,3) knowledge_chunks schema: required columns, generated chars, FTS uses 'simple'", () => {
  const t = tableBody("knowledge_chunks");
  for (const col of [
    "id uuid primary key default gen_random_uuid()",
    "workspace_id uuid not null references public.workspaces(id) on delete cascade",
    "resource_id uuid not null",
    "document_id uuid not null",
    "chunk_index integer not null",
    "content text not null",
    "content_hash text not null",
    "content_version integer not null",
    "source_label text not null",
    "heading text,",
    "created_at timestamptz not null default now()",
  ]) {
    assert.ok(t.includes(col), col);
  }
  assert.ok(t.includes("chars integer generated always as (char_length(content)) stored"), "generated chars");
  assert.ok(
    t.includes("fts tsvector generated always as ( to_tsvector('simple'::regconfig, coalesce(heading, '') || ' ' || content) ) stored"),
    "generated FTS over heading + content with the 'simple' configuration"
  );
  assert.equal([...sql.matchAll(/create table /g)].length, 1, "exactly one table is created");
});

test("(4,28,29) no vector/embedding fields, no pgvector, no CREATE EXTENSION", () => {
  assert.doesNotMatch(sql, /embedding|pgvector|\bvector\b|hnsw|ivfflat|metadata jsonb|updated_at/);
  assert.doesNotMatch(sql, /create extension/);
});

test("(5,6,7) composite document FK on its new unique target, ON DELETE CASCADE", () => {
  // The unique composite target is added to knowledge_documents, guarded for idempotency.
  assert.ok(
    sql.includes(
      "alter table public.knowledge_documents add constraint knowledge_documents_ws_res_id_key unique (workspace_id, resource_id, id)"
    ),
    "documents gain the composite unique target"
  );
  assert.ok(sql.includes("if not exists (select 1 from pg_constraint where conname = 'knowledge_documents_ws_res_id_key')"), "guarded (idempotent)");
  // One FK proves workspace + resource + owning document and cascades deletes.
  assert.ok(
    sql.includes(
      "constraint knowledge_chunks_document_fk foreign key (workspace_id, resource_id, document_id) references public.knowledge_documents (workspace_id, resource_id, id) on delete cascade"
    ),
    "composite FK with CASCADE"
  );
});

test("(8,9) uniqueness and size constraints", () => {
  const t = tableBody("knowledge_chunks");
  assert.ok(t.includes("constraint knowledge_chunks_doc_uniq unique (document_id, chunk_index)"), "unique (document_id, chunk_index)");
  assert.ok(t.includes("check (chunk_index >= 0)"));
  assert.ok(t.includes("check (char_length(content) between 1 and 4000)"), "4,000-char hard cap");
  assert.ok(t.includes("check (char_length(btrim(content_hash)) > 0)"));
  assert.ok(t.includes("check (content_version >= 0)"));
});

test("approved indexes only: GIN(fts) + btree (workspace_id, resource_id)", () => {
  assert.ok(sql.includes("create index if not exists knowledge_chunks_fts_idx on public.knowledge_chunks using gin (fts)"));
  assert.ok(sql.includes("create index if not exists knowledge_chunks_ws_resource_idx on public.knowledge_chunks (workspace_id, resource_id)"));
  assert.equal([...sql.matchAll(/create (?:unique )?index /g)].length, 2, "no unapproved indexes");
});

// ------------------------------------------------------------ RLS / grants (10–13)

test("(10,11,12,13) deny-all browser posture; minimum service_role access", () => {
  assert.ok(ddl.includes("alter table public.knowledge_chunks enable row level security"));
  assert.doesNotMatch(ddl, /create policy/, "zero policies");
  assert.ok(ddl.includes("revoke all on table public.knowledge_chunks from anon, authenticated"));
  assert.ok(ddl.includes("grant select, insert, update, delete on table public.knowledge_chunks to service_role"));
  // No grant to anything but service_role; no role creation or broad grants.
  for (const m of ddl.matchAll(/grant [^;]*? to ([a-z_]+)/g)) assert.equal(m[1], "service_role", m[0]);
});

// ------------------------------------------------------------ reindex RPC (14–18)

test("(14,15,16) reindex RPC: SECURITY INVOKER, empty search_path, service-role-only EXECUTE", () => {
  const f = fn(REINDEX.name);
  assert.ok(f.header.includes("security invoker"));
  assert.ok(f.header.includes("set search_path = ''"));
  assert.ok(ddl.includes(`revoke all on function public.${REINDEX.name}${REINDEX.sig} from public, anon, authenticated`));
  assert.ok(ddl.includes(`grant execute on function public.${REINDEX.name}${REINDEX.sig} to service_role`));
});

test("(17) stale-input guard: locked document, hash verified BEFORE any mutation, stale writes nothing", () => {
  const { body } = fn(REINDEX.name);
  const lockAt = body.indexOf("for update");
  const staleAt = body.indexOf("doc.content_hash is distinct from p_content_hash");
  const deleteAt = body.indexOf("delete from public.knowledge_chunks");
  const insertAt = body.indexOf("insert into public.knowledge_chunks");
  assert.ok(lockAt > 0 && staleAt > lockAt && deleteAt > staleAt && insertAt > deleteAt, "lock → hash check → delete → insert, in order");
  assert.ok(body.includes("return jsonb_build_object('stale_input', true, 'replaced', false, 'chunks', 0)"), "stale input returns without mutating");
  // Ownership and the authoritative hash are derived from the locked row, never caller JSON.
  assert.ok(body.includes("(doc.workspace_id, doc.resource_id, doc.id, idx, c->>'content', doc.content_hash"), "workspace/resource/hash come from the locked document");
  assert.doesNotMatch(body, /c->>'workspace_id'|c->>'resource_id'|c->>'content_hash'|c->>'content_version'/, "caller JSON cannot set ownership or authority fields");
  // Defensive JSON validation.
  assert.ok(body.includes("jsonb_typeof(coalesce(p_chunks, 'null'::jsonb)) <> 'array'"));
  assert.ok(body.includes("coalesce((c->>'chunk_index')::integer, -1) <> idx"), "chunk_index must be exactly 0..n-1 in order");
});

test("(18) transactional replacement: delete + complete insert inside ONE function (one transaction), no partial path", () => {
  const { body } = fn(REINDEX.name);
  assert.equal([...body.matchAll(/delete from public\.knowledge_chunks/g)].length, 1);
  assert.equal([...body.matchAll(/insert into public\.knowledge_chunks/g)].length, 1);
  assert.doesNotMatch(body, /commit|begin transaction|savepoint/, "no sub-transaction tricks — the function IS the transaction");
});

// ------------------------------------------------------------ match RPC (19–27)

test("(19,20) match RPC: SECURITY INVOKER, empty search_path, service-role-only", () => {
  const f = fn(MATCH.name);
  assert.ok(f.header.includes("security invoker"));
  assert.ok(f.header.includes("set search_path = ''"));
  assert.ok(f.header.includes("stable"), "read-only (STABLE)");
  assert.ok(ddl.includes(`revoke all on function public.${MATCH.name}${MATCH.sig} from public, anon, authenticated`));
  assert.ok(ddl.includes(`grant execute on function public.${MATCH.name}${MATCH.sig} to service_role`));
});

test("(21,22,23) candidate universe: workspace+agent assignments → resources → ready documents → current-hash chunks, BEFORE ranking", () => {
  const { body } = fn(MATCH.name);
  // The join chain starts from the agent's own assignment rows…
  const joinChain = /from public\.agent_knowledge_resources a join public\.knowledge_resources r on r\.workspace_id = a\.workspace_id and r\.id = a\.resource_id join public\.knowledge_documents d on d\.workspace_id = a\.workspace_id and d\.resource_id = r\.id and d\.status = 'ready' join public\.knowledge_chunks c on c\.workspace_id = a\.workspace_id and c\.document_id = d\.id and c\.content_hash = d\.content_hash where a\.workspace_id = p_workspace_id and a\.agent_id = p_agent_id/;
  // …in BOTH the universe count and the ranking query (identical scoping).
  assert.equal([...body.matchAll(new RegExp(joinChain.source, "g"))].length, 2, "universe and ranking share the exact tenant-scoped chain");
  // Ranking (fts @@) applies only inside that chain — never on a global chunk scan.
  const rankingAt = body.indexOf("c.fts @@ tsq");
  assert.ok(rankingAt > body.indexOf("where a.workspace_id = p_workspace_id"), "ranking after tenant scoping");
  assert.ok(body.includes("'searched_chunks', universe"), "universe size reported (indexed-but-no-match vs nothing-indexed)");
  // STALENESS INVARIANT: hash equality + ready status gate every chunk;
  // content_version is never an authority check.
  assert.doesNotMatch(body, /content_version/, "content_version plays no part in retrieval");
});

test("(24,25,26,27) 'simple' websearch query, ts_rank_cd 32, top-K ≤ 20, deterministic tie-breaking", () => {
  const { body, header } = fn(MATCH.name);
  assert.ok((header + body).includes("websearch_to_tsquery('simple'::regconfig, coalesce(p_query, ''))"));
  assert.ok(body.includes("ts_rank_cd(c.fts, tsq, 32)"));
  assert.ok((header + body).includes("greatest(1, least(coalesce(p_top_k, 8), 20))"), "top-K defensively bounded to 20");
  assert.ok(body.includes("order by score desc, a.position, d.position, c.chunk_index, c.id"), "deterministic tie-breaking");
  assert.ok(body.includes("numnode(tsq) > 0"), "degenerate queries return empty matches, never scan");
});

// ------------------------------------------------------------ additive (30)

test("(30) additive to 0065/0067: no drops/renames/truncates, no changes to existing columns, policies or grants", () => {
  // No destructive statement anywhere in the code (comments already stripped;
  // the guarded DO block and function bodies are inside `sql`).
  assert.doesNotMatch(sql, /drop table|drop column|drop function|drop policy|drop index|drop constraint|rename |truncate |alter policy|alter column/);
  // The ONLY alters: enable RLS on the new table, and ADD the unique target on
  // knowledge_documents (inside the idempotency-guarded DO block).
  const alters = [...sql.matchAll(/alter table (?:if exists )?(?:only )?(?:public\.)?([a-z_]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(alters)].sort(), ["knowledge_chunks", "knowledge_documents"]);
  const docAlters = [...sql.matchAll(/alter table public\.knowledge_documents\s+([a-z]+ [a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(docAlters, ["add constraint"], "documents are only ever ADDed a constraint");
  // No revoke/grant touching the 0065 tables, no a7_guard, no production ref.
  assert.doesNotMatch(ddl, /(grant|revoke)[^;]*(knowledge_resources|knowledge_documents\b(?!_ws_res_id_key))[^;]*;/);
  assert.ok(!sql.includes("a7_guard"));
  assert.ok(!raw.includes("mzqynjywncbvqfikbzgm"));
  // The migration itself writes no data: DML only inside function bodies, and
  // those bodies write ONLY knowledge_chunks.
  assert.doesNotMatch(ddl, /insert into|delete from|update public\./);
  for (const m of sql.matchAll(/(?:insert into|delete from) public\.([a-z_]+)/g)) {
    assert.equal(m[1], "knowledge_chunks", `functions write only knowledge_chunks (got ${m[1]})`);
  }
});

// ------------------------------------------------------------ A7 preparation

test("apply-0068 is pinned: one migration, hash matches disk, steps stay disjoint, prior pins unchanged", () => {
  assert.deepEqual(A7_STEPS["apply-0068"].migrations.map((m) => m.file), [FILE]);
  const diskHash = createHash("sha256").update(fs.readFileSync(path.join(dir, FILE))).digest("hex");
  assert.equal(A7_STEPS["apply-0068"].migrations[0].sha256, diskHash, "pinned hash matches disk");
  for (const step of ["baseline-0001-0064", "apply-0065", "apply-0066", "apply-0067"]) {
    assert.ok(!A7_STEPS[step].migrations.some((m) => m.file === FILE), `${step} does not chain 0068`);
  }
  assert.equal(A7_STEPS["apply-0065"].migrations[0].sha256, "7976604d40146bd3dbf1b0db0a645ff3c06e3e9209b9651a92b2411a11196263");
  assert.equal(A7_STEPS["apply-0067"].migrations[0].sha256, "7151787dc4578eae7699d57b46297d799401eb21cc9d6678d2ff42ef80dec3e8");
  // Closed world: every step still validates with 0068 on disk, and 0068's own
  // step validates — no arbitrary execution path exists (only pinned steps).
  for (const step of Object.keys(A7_STEPS)) validateStepManifest(step, realDisk());
});

test("dry-run apply-0068 performs zero HTTP and passes static checks (it never executes automatically)", async () => {
  const { A7_PROJECT_REF, A7_SUPABASE_URL } = await import("@/lib/a7-guard");
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = () => { fetches++; throw new Error("network use attempted"); };
  try {
    const report = runDryRun({
      stepId: "apply-0068",
      readDisk: realDisk,
      readSql: (f) => fs.readFileSync(path.join(dir, f), "utf8"),
      readEnvFile: () => [
        "A7_MODE=1",
        `A7_EXPECTED_REF=${A7_PROJECT_REF}`,
        `NEXT_PUBLIC_SUPABASE_URL=${A7_SUPABASE_URL}`,
        "A7_SENTINEL_TOKEN=11111111-2222-4333-8444-555555555555",
        "A7_SUPABASE_MGMT_TOKEN=sbp_FAKE_fixture_management_token_000",
      ].join("\n"),
    });
    assert.equal(report.ok, true, JSON.stringify(report.checks));
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0);
});
