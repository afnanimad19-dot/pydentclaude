// Static checks for migration 0065 (Central Knowledge Base, Phase A schema +
// A4.1 atomic write functions). The migration is NOT applied by these tests —
// they read the SQL text only. Static checks are NOT a substitute for the later
// execution of 0065 against a safe non-production PostgreSQL/Supabase database.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dir = path.join(root, "supabase", "migrations");
const FILE = "0065_central_knowledge.sql";
const raw = fs.readFileSync(path.join(dir, FILE), "utf8");
// Strip comments so rollback notes / prose can never satisfy (or trip) a check.
const normalize = (text) => text.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").toLowerCase();
const sql = normalize(raw);
// DDL outside function bodies ($$ … $$): where "additive only" is judged.
const outsideBodies = (n) => n.replace(/\$\$[\s\S]*?\$\$/g, "$$ $$");
const ddl = outsideBodies(sql);

const RPC = {
  apply: { name: "knowledge_apply_document_changes", sig: "(uuid, uuid, uuid, jsonb, jsonb)" },
  dup: { name: "knowledge_duplicate_resource", sig: "(uuid, uuid, text, uuid)" },
};

/** Header (signature … `as`) and body of a function in normalized SQL. */
function fn(n, name) {
  const start = n.indexOf(`create or replace function public.${name}(`);
  assert.ok(start >= 0, `function ${name}`);
  const open = n.indexOf("$$", start);
  const close = n.indexOf("$$", open + 2);
  assert.ok(open > start && close > open, `${name} body`);
  return { header: n.slice(start, open), body: n.slice(open + 2, close) };
}

const NEW_TABLES = ["knowledge_resources", "knowledge_documents", "agent_knowledge_resources"];

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

test("0065 is the next migration and the only one touching Central KB tables", () => {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const max = Math.max(...files.map((f) => parseInt(f, 10)).filter(Number.isFinite));
  // 0066_clinic_scheduling (renumbered from a duplicate 0061) is deliberately
  // OUTSIDE the A7 baseline (0001–0064) and applied after 0065.
  // 0067_central_knowledge_grants (grants-only repair for 0065's service_role
  // access) and 0068_knowledge_chunks (Phase 2A chunk layer, additive) are the
  // ONLY other files allowed to name the Central KB tables — each enforced by
  // its own static suite (tests/a7-grants-0067, tests/knowledge-chunks-migration).
  assert.equal(max, 68);
  assert.deepEqual(files.filter((f) => f.startsWith("0065")), [FILE]);
  const MAY_NAME_KB = [FILE, "0067_central_knowledge_grants.sql", "0068_knowledge_chunks.sql"];
  for (const f of files.filter((x) => !MAY_NAME_KB.includes(x))) {
    const s = fs.readFileSync(path.join(dir, f), "utf8");
    assert.doesNotMatch(s, /knowledge_resources|knowledge_documents|agent_knowledge_resources/, f);
  }
});

test("all three tables are created idempotently", () => {
  for (const t of NEW_TABLES) assert.ok(sql.includes(`create table if not exists public.${t} (`), t);
  assert.equal([...sql.matchAll(/create table /g)].length, 3, "no other table is created");
});

test("additive only: no ALTER of agents or any existing table, no drops/renames/truncates", () => {
  assert.doesNotMatch(sql, /alter table (if exists )?(public\.)?agents\b/);
  const alters = [...sql.matchAll(/alter table (?:if exists )?(?:only )?(?:public\.)?([a-z_]+)/g)].map((m) => m[1]);
  assert.ok(alters.length > 0);
  for (const t of alters) assert.ok(NEW_TABLES.includes(t), `ALTER only on new tables (got ${t})`);
  assert.doesNotMatch(sql, /drop table|drop column|rename |truncate |drop index|drop constraint|drop policy|alter policy/);
  // The migration itself changes no data: DML appears only inside function bodies…
  assert.doesNotMatch(ddl, /delete from|update public\.|insert into/);
  // …and those bodies write only the two Central KB content tables.
  for (const m of sql.matchAll(/(?:insert into|update|delete from) public\.([a-z_]+)/g)) {
    assert.ok(["knowledge_resources", "knowledge_documents"].includes(m[1]), `function writes only Central KB tables (got ${m[1]})`);
  }
  // The only DROPs are idempotent re-creations of this migration's own triggers.
  for (const m of sql.matchAll(/drop trigger if exists ([a-z_]+) on public\.([a-z_]+)/g)) {
    assert.ok(NEW_TABLES.includes(m[2]), `drop trigger only on new tables (${m[2]})`);
  }
  assert.doesNotMatch(sql, /drop (function|trigger)(?! if exists [a-z_]+ on public\.(knowledge_resources|knowledge_documents|agent_knowledge_resources))/);
  // Indexes and triggers are created only on the new tables.
  for (const m of sql.matchAll(/create (?:unique )?index if not exists [a-z_]+ on public\.([a-z_]+)/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1]);
  for (const m of sql.matchAll(/create trigger [a-z_]+ before [a-z ]+ on public\.([a-z_]+)/g)) assert.ok(NEW_TABLES.includes(m[1]), m[1]);
  // agents is only REFERENCED (FK target + read in the validation trigger) —
  // never by the write functions.
  const agentRefs = [...sql.matchAll(/public\.agents\b/g)].length;
  assert.equal(agentRefs, 2);
  assert.match(sql, /references public\.agents\(id\) on delete cascade/);
  assert.match(sql, /from public\.agents a where a\.id = new\.agent_id and a\.workspace_id = new\.workspace_id/);
});

test("foreign keys: workspace cascade, documents → resource cascade, assignment → resource NO ACTION, agent cascade", () => {
  for (const t of NEW_TABLES) {
    assert.match(tableBody(t), /workspace_id uuid not null references public\.workspaces\(id\) on delete cascade/, `${t} workspace cascade`);
  }
  const docs = tableBody("knowledge_documents");
  assert.match(docs, /foreign key \(workspace_id, resource_id, kind\) references public\.knowledge_resources \(workspace_id, id, type\) on delete cascade/);
  assert.match(docs, /resource_id uuid not null/);
  const asg = tableBody("agent_knowledge_resources");
  assert.match(asg, /agent_id uuid not null references public\.agents\(id\) on delete cascade/);
  assert.match(asg, /foreign key \(workspace_id, resource_id\) references public\.knowledge_resources \(workspace_id, id\) on delete no action/);
  assert.match(asg, /resource_id uuid not null/);
  // Resource deletion protection is a DB constraint: NO ACTION, never cascade / set null.
  assert.doesNotMatch(asg, /knowledge_resources \(workspace_id, id\) on delete (cascade|set null|set default)/);
});

test("composite-key targets exist so cross-workspace references are impossible", () => {
  const res = tableBody("knowledge_resources");
  assert.match(res, /constraint knowledge_resources_ws_id_key unique \(workspace_id, id\)/);
  assert.match(res, /constraint knowledge_resources_ws_id_type_key unique \(workspace_id, id, type\)/);
});

test("assignment workspace validation trigger exists and fires on insert and update", () => {
  assert.match(sql, /create or replace function public\.agent_knowledge_resources_check_ws\(\) returns trigger/);
  assert.match(sql, /raise exception 'knowledge assignment refused: the agent does not belong to this workspace\.'/);
  assert.match(sql, /create trigger agent_knowledge_resources_check_ws before insert or update on public\.agent_knowledge_resources for each row execute function public\.agent_knowledge_resources_check_ws\(\)/);
});

test("deny-all browser access: RLS enabled on all three, no policies, no grants, grants revoked", () => {
  for (const t of NEW_TABLES) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`), `${t} rls`);
    assert.match(sql, new RegExp(`revoke all on table public\\.${t} from anon, authenticated`), `${t} revoke`);
  }
  assert.doesNotMatch(sql, /create policy|alter policy/);
  // The ONLY grants: EXECUTE on the two write functions, to service_role. No table grant.
  const grants = [...sql.matchAll(/\bgrant [^;]*;/g)].map((m) => m[0]);
  assert.deepEqual(grants, [
    `grant execute on function public.${RPC.apply.name}${RPC.apply.sig} to service_role;`,
    `grant execute on function public.${RPC.dup.name}${RPC.dup.sig} to service_role;`,
  ]);
  // FORCE would block the table owner (SQL editor / migrations) — not used.
  assert.doesNotMatch(sql, /force row level security/);
  // Functions run as the invoker (no privilege escalation from the browser).
  assert.doesNotMatch(sql, /security definer/);
});

test("indexes and uniqueness rules", () => {
  assert.match(sql, /create unique index if not exists knowledge_resources_ws_name_uniq on public\.knowledge_resources \(workspace_id, lower\(btrim\(name\)\)\)/);
  assert.match(sql, /create index if not exists knowledge_resources_ws_updated_idx on public\.knowledge_resources \(workspace_id, updated_at desc\)/);
  assert.match(sql, /create unique index if not exists knowledge_documents_file_uniq on public\.knowledge_documents \(resource_id, lower\(btrim\(filename\)\)\) where kind = 'file'/);
  assert.match(sql, /create unique index if not exists knowledge_documents_url_uniq on public\.knowledge_documents \(resource_id, source_url\) where kind = 'url'/);
  assert.match(sql, /create index if not exists knowledge_documents_resource_pos_idx on public\.knowledge_documents \(resource_id, position\)/);
  assert.match(sql, /create index if not exists agent_knowledge_resources_resource_idx on public\.agent_knowledge_resources \(resource_id\)/);
  assert.match(sql, /create index if not exists agent_knowledge_resources_ws_agent_idx on public\.agent_knowledge_resources \(workspace_id, agent_id\)/);
  assert.match(tableBody("agent_knowledge_resources"), /primary key \(agent_id, resource_id\)/);
});

test("approved limits and value checks are enforced in the schema", () => {
  const res = tableBody("knowledge_resources");
  assert.match(res, /check \(char_length\(btrim\(name\)\) between 1 and 80\)/);
  assert.match(res, /check \(type in \('file', 'url'\)\)/);
  assert.match(res, /check \(status in \('empty', 'processing', 'ready', 'error'\)\)/);
  assert.match(res, /refresh_interval_hours in \(6, 12, 24, 168\)/);
  assert.match(res, /refresh_enabled boolean not null default false/);
  const docs = tableBody("knowledge_documents");
  assert.match(docs, /check \(char_length\(content\) <= 200000\)/);
  assert.match(docs, /char_count integer generated always as \(char_length\(content\)\) stored/);
  assert.match(docs, /check \(kind in \('file', 'url'\)\)/);
  assert.match(docs, /storage_path text,/);
  // 50 documents per resource, race-safe (parent row locked before counting).
  assert.match(sql, /perform 1 from public\.knowledge_resources r where r\.id = new\.resource_id for update/);
  assert.match(sql, />= 50 then raise exception 'a knowledge resource can hold at most 50 documents\.'/);
  assert.match(sql, /create trigger knowledge_documents_limit before insert on public\.knowledge_documents/);
});

test("re-runnable: every create uses IF NOT EXISTS / OR REPLACE, triggers are dropped first", () => {
  assert.equal([...sql.matchAll(/create table (?!if not exists)/g)].length, 0);
  assert.equal([...sql.matchAll(/create (?:unique )?index (?!if not exists)/g)].length, 0);
  assert.equal([...sql.matchAll(/create function/g)].length, 0, "functions use create or replace");
  assert.equal([...sql.matchAll(/create or replace function /g)].length, 5, "3 trigger functions + 2 write functions");
  const triggers = [...sql.matchAll(/create trigger ([a-z_]+) /g)].map((m) => m[1]);
  for (const t of triggers) assert.match(sql, new RegExp(`drop trigger if exists ${t} on`), t);
});

test("no runtime / legacy knowledge columns are touched by the migration", () => {
  assert.doesNotMatch(sql, /knowledge_base|kb_files|knowledge_source|voice_settings/);
  assert.doesNotMatch(sql, /vector|embedding|storage\.buckets|storage\.objects/);
});

// ------------------------------------------------------------ A4.1 atomic write functions

/** Every A4.1 RPC requirement, as one checker (re-used by the damage test below). */
function checkRpcs(n) {
  const apply = fn(n, RPC.apply.name);
  const dup = fn(n, RPC.dup.name);

  // Signatures, invoker rights, locked-down search path.
  assert.match(apply.header, /^create or replace function public\.knowledge_apply_document_changes\( p_workspace_id uuid, p_resource_id uuid, p_user_id uuid, p_changes jsonb, p_resource jsonb default '\{\}'::jsonb \) returns jsonb/);
  assert.match(dup.header, /^create or replace function public\.knowledge_duplicate_resource\( p_workspace_id uuid, p_source_id uuid, p_name text, p_user_id uuid \) returns jsonb/);
  for (const f of [apply, dup]) {
    assert.match(f.header, /language plpgsql security invoker set search_path = '' as $/, "invoker + empty search_path");
    // Atomic by construction: no transaction control, no exception handler that could swallow a failure.
    assert.doesNotMatch(f.body, /\bcommit\b|\brollback\b|\bsavepoint\b|exception when|dblink|\bexecute\b/);
    // Never touches assignments or agents; never deletes a resource.
    assert.doesNotMatch(f.body, /agent_knowledge_resources|public\.agents\b|delete from public\.knowledge_resources/);
    // Every table is schema-qualified (nothing resolvable through a search path).
    // (relations only: function calls such as jsonb_array_elements(…) resolve in pg_catalog.)
    const rels = [...f.body.matchAll(/\b(?:from|insert into|update|join)\s+([a-z_.]+)(?![a-z_.]|\s*\()/g)].map((m) => m[1]);
    assert.ok(rels.length >= 4);
    for (const r of rels) assert.ok(r.startsWith("public."), `qualified: ${r}`);
  }

  // Permissions: PUBLIC, anon and authenticated revoked; service_role granted.
  for (const r of [RPC.apply, RPC.dup]) {
    assert.ok(n.includes(`revoke all on function public.${r.name}${r.sig} from public, anon, authenticated;`), `${r.name} revoke`);
    assert.ok(n.includes(`grant execute on function public.${r.name}${r.sig} to service_role;`), `${r.name} grant`);
    assert.doesNotMatch(n, new RegExp(`grant [^;]*${r.name}[^;]* to (public|anon|authenticated)`));
  }
  assert.doesNotMatch(n, /security definer/);

  // ---- apply: workspace boundary, lock, one database-side increment.
  const a = apply.body;
  assert.match(a, /select \* into res from public\.knowledge_resources k where k\.id = p_resource_id and k\.workspace_id = p_workspace_id for update;/);
  assert.match(a, /if not found then raise exception 'knowledge resource not found\.' using errcode = 'p0002', hint = 'resource';/);
  assert.match(a, /where d\.id = \(c->>'id'\)::uuid and d\.resource_id = p_resource_id and d\.workspace_id = p_workspace_id for update;/);
  assert.match(a, /values \(p_workspace_id, p_resource_id, c->>'kind'/, "insert takes workspace/resource from parameters");
  assert.match(a, /raise exception 'knowledge document not found\.' using errcode = 'p0002', hint = 'document';/);
  assert.equal([...a.matchAll(/content_version =/g)].length, 1, "one version write");
  assert.match(a, /content_version = k\.content_version \+ case when did_change then 1 else 0 end/);
  assert.match(a, /if old_doc\.content is distinct from coalesce\(c->>'content', ''\) or old_doc\.status is distinct from coalesce\(c->>'status', 'ready'\) then did_change := true;/, "unchanged replace does not bump");
  const touch = a.slice(a.indexOf("elsif op = 'touch' then"), a.indexOf("else delete from"));
  assert.ok(touch.length > 0);
  assert.doesNotMatch(touch, /content =|did_change := true/, "touch never changes content or the version");
  assert.match(a, /where k\.id = res\.id and k\.workspace_id = p_workspace_id returning \* into res;/);

  // ---- duplicate: source in the workspace, new ids, order kept, no assignments.
  const d = dup.body;
  assert.match(d, /select \* into src from public\.knowledge_resources k where k\.id = p_source_id and k\.workspace_id = p_workspace_id for share;/);
  assert.match(d, /raise exception 'knowledge resource not found\.' using errcode = 'p0002', hint = 'resource';/);
  assert.match(d, /insert into public\.knowledge_resources \(workspace_id, name, description, type, status, refresh_enabled, refresh_interval_hours, content_version, created_by, updated_by\) values \(p_workspace_id, btrim\(p_name\), src\.description, src\.type, 'empty', src\.refresh_enabled, src\.refresh_interval_hours, 0, p_user_id, p_user_id\)/);
  const copy = d.match(/insert into public\.knowledge_documents \(([^)]*)\) select ([\s\S]*?) from public\.knowledge_documents d where ([^;]*);/);
  assert.ok(copy, "documents copied with one INSERT … SELECT");
  assert.doesNotMatch(copy[1], /(^|, )id(,|$)/, "no id column: new document ids are generated");
  assert.doesNotMatch(copy[2], /\bd\.id\b(?! *\))/, "source document ids are not copied");
  assert.match(copy[2], /^p_workspace_id, dst\.id, /, "copies go to the NEW resource in the same workspace");
  assert.match(copy[2], /\(row_number\(\) over \(order by d\.position, d\.created_at, d\.id\) - 1\)::integer$/, "order preserved");
  assert.equal(copy[3].trim(), "d.resource_id = src.id and d.workspace_id = p_workspace_id");
  assert.match(d, /content_version = case when copied > 0 then 1 else 0 end where k\.id = dst\.id and k\.workspace_id = p_workspace_id/);
}

test("A4.1: atomic duplicate + document/version functions exist, are server-only and enforce workspace boundaries", () => {
  checkRpcs(sql);
});

test("A4.1: the damage test — each deliberately broken copy of 0065 is detected", () => {
  const damage = [
    ["grant to anon", (t) => t.replace("to service_role;\ngrant", "to service_role, anon;\ngrant")],
    ["authenticated not revoked", (t) => t.replace("(uuid, uuid, text, uuid) from public, anon, authenticated", "(uuid, uuid, text, uuid) from public, anon")],
    ["security definer", (t) => t.replace(/security invoker/, "security definer")],
    ["search_path widened", (t) => t.replace("set search_path = ''", "set search_path = public")],
    ["apply: no workspace check", (t) => t.replace("where k.id = p_resource_id and k.workspace_id = p_workspace_id", "where k.id = p_resource_id")],
    ["apply: no row lock", (t) => t.replace(/k\.workspace_id = p_workspace_id\n   for update;/, "k.workspace_id = p_workspace_id;")],
    ["apply: app-side version", (t) => t.replace("content_version = k.content_version + case when did_change then 1 else 0 end", "content_version = (p_resource->>'content_version')::integer")],
    ["apply: unconditional bump on replace", (t) => t.replace("if old_doc.content is distinct from", "if true or old_doc.content is distinct from")],
    ["apply: insert trusts payload workspace", (t) => t.replace("(p_workspace_id, p_resource_id, c->>'kind'", "((c->>'workspace_id')::uuid, p_resource_id, c->>'kind'")],
    ["apply: swallowed error", (t) => t.replace("  return jsonb_build_object('resource', to_jsonb(res)", "  return jsonb_build_object('resource', to_jsonb(res)") .replace("end $$;\n\n-- Duplicate", "exception when others then return null;\nend $$;\n\n-- Duplicate")],
    ["dup: copies assignments", (t) => t.replace("  get diagnostics copied = row_count;", "  get diagnostics copied = row_count;\n  insert into public.agent_knowledge_resources (workspace_id, agent_id, resource_id) select workspace_id, agent_id, dst.id from public.agent_knowledge_resources where resource_id = src.id;")],
    ["dup: copies document ids", (t) => t.replace("(workspace_id, resource_id, kind, source_url, filename, mime, content, content_hash, fetched_at, status, error, position)\n  select p_workspace_id, dst.id,", "(id, workspace_id, resource_id, kind, source_url, filename, mime, content, content_hash, fetched_at, status, error, position)\n  select d.id, p_workspace_id, dst.id,")],
    ["dup: no workspace filter on documents", (t) => t.replace("where d.resource_id = src.id and d.workspace_id = p_workspace_id;", "where d.resource_id = src.id;")],
    ["dup: order lost", (t) => t.replace("order by d.position, d.created_at, d.id", "order by d.id")],
    ["dup: source not workspace-checked", (t) => t.replace("where k.id = p_source_id and k.workspace_id = p_workspace_id", "where k.id = p_source_id")],
  ];
  for (const [name, hurt] of damage) {
    const broken = hurt(raw);
    assert.notEqual(broken, raw, `damage "${name}" applied`);
    assert.throws(() => checkRpcs(normalize(broken)), assert.AssertionError, `damage "${name}" must be detected`);
  }
});

test("A4.1: the deny-all table model and deletion semantics are unchanged by the functions", () => {
  for (const t of NEW_TABLES) {
    assert.match(sql, new RegExp(`alter table public\\.${t} enable row level security`));
    assert.match(sql, new RegExp(`revoke all on table public\\.${t} from anon, authenticated`));
    assert.doesNotMatch(sql, new RegExp(`grant [^;]* on (table )?public\\.${t}\\b`), `${t}: no table grant`);
  }
  assert.match(tableBody("agent_knowledge_resources"), /references public\.knowledge_resources \(workspace_id, id\) on delete no action/);
  assert.match(tableBody("knowledge_documents"), /references public\.knowledge_resources \(workspace_id, id, type\) on delete cascade/);
  // The functions never delete a resource and never write assignments.
  for (const r of [RPC.apply, RPC.dup]) assert.doesNotMatch(fn(sql, r.name).body, /delete from public\.knowledge_resources|agent_knowledge_resources/);
  // Rollback notes list the functions.
  assert.match(raw, /drop function if exists public\.knowledge_apply_document_changes\(uuid, uuid, uuid, jsonb, jsonb\);/);
  assert.match(raw, /drop function if exists public\.knowledge_duplicate_resource\(uuid, uuid, text, uuid\);/);
});
