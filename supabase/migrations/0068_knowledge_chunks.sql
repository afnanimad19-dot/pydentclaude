-- Pydent — migration 68: persisted Central Knowledge chunks + PostgreSQL FTS
-- (Phase 2A schema). NO vectors, NO embeddings, NO extensions.
--
-- Additive only. Creates ONE new table (knowledge_chunks), ONE new unique
-- constraint on knowledge_documents (the composite-FK target), and TWO
-- server-only functions:
--
--   knowledge_chunks             persisted retrieval chunks of one document
--   knowledge_reindex_document   transactional, race-safe chunk replacement
--   knowledge_match_chunks       tenant+agent-scoped FTS retrieval
--
-- It does NOT alter any existing column, policy, grant, trigger or function,
-- and nothing in the application reads or writes these objects yet (that is
-- Phase 2B/2D, each separately approved).
--
-- AUTHORITY MODEL (operator-approved):
--   A chunk is authoritative ONLY when
--       chunk.content_hash = document.content_hash  AND  document.status = 'ready'.
--   knowledge_documents.content_hash is the correctness authority — it is
--   rewritten atomically with the content by knowledge_apply_document_changes
--   (0065), so a content change instantly invalidates old chunks through the
--   retrieval join, whatever the cleanup timing. content_version (the RESOURCE
--   version, copied onto chunks at index time) is observability/debugging only
--   and MUST NOT be used as an authority check.
--
-- Access model (deny-all for the browser, exactly like 0065/0067): RLS is
-- enabled with NO policies, anon/authenticated table access is revoked, the
-- service role gets the minimum table access, and both functions are
-- SECURITY INVOKER with EXECUTE revoked from PUBLIC/anon/authenticated and
-- granted only to service_role. search_path = '' and schema-qualified names
-- prevent object substitution.
--
-- Idempotent where practical: IF NOT EXISTS / OR REPLACE / guarded constraint.

-- ------------------------------------------------------ composite-FK target
-- knowledge_documents gains the unique target the chunk FK references, so the
-- database itself proves workspace + resource + owning document all agree.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'knowledge_documents_ws_res_id_key') then
    alter table public.knowledge_documents
      add constraint knowledge_documents_ws_res_id_key unique (workspace_id, resource_id, id);
  end if;
end $$;

-- ------------------------------------------------------------------ chunks
create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  resource_id uuid not null,
  document_id uuid not null,
  chunk_index integer not null,
  content text not null,
  -- SHA-256 of the PARENT DOCUMENT's content that produced this chunk — the
  -- staleness key. Stamped by knowledge_reindex_document from the LOCKED
  -- document row, never from caller input.
  content_hash text not null,
  -- The owning RESOURCE's content_version at index time. Observability only.
  content_version integer not null,
  source_label text not null,
  heading text,
  chars integer generated always as (char_length(content)) stored,
  fts tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(heading, '') || ' ' || content)
  ) stored,
  created_at timestamptz not null default now(),
  constraint knowledge_chunks_index_chk check (chunk_index >= 0),
  constraint knowledge_chunks_content_chk check (char_length(content) between 1 and 4000),
  constraint knowledge_chunks_hash_chk check (char_length(btrim(content_hash)) > 0),
  constraint knowledge_chunks_version_chk check (content_version >= 0),
  constraint knowledge_chunks_label_chk check (char_length(btrim(source_label)) between 1 and 200),
  constraint knowledge_chunks_doc_uniq unique (document_id, chunk_index),
  -- ONE foreign key proves: same workspace, same resource, actual owning
  -- document — and deleting the document (or, by cascade, its resource or
  -- workspace) removes its chunks.
  constraint knowledge_chunks_document_fk foreign key (workspace_id, resource_id, document_id)
    references public.knowledge_documents (workspace_id, resource_id, id) on delete cascade
);

-- The FTS scan, and the retrieval join's entry edge (assigned resources → chunks).
create index if not exists knowledge_chunks_fts_idx
  on public.knowledge_chunks using gin (fts);
create index if not exists knowledge_chunks_ws_resource_idx
  on public.knowledge_chunks (workspace_id, resource_id);

-- ------------------------------------------------- reindex (server only)
-- Replace ONE document's chunk set in ONE transaction, race-safely.
--
-- The caller (Phase 2B's indexing service; nothing calls this yet) chunks the
-- document content it just wrote and supplies the deterministic complete set:
--   p_chunks: [{"chunk_index":0,"content":"…","source_label":"…","heading":null}, …]
--   with chunk_index exactly 0..n-1 in order.
--
-- Tenant/resource ownership and the authoritative hash/version are DERIVED
-- from the locked document row and its resource — the supplied JSON cannot
-- set workspace_id, resource_id, content_hash or content_version.
--
-- Race safety: the document row is locked FOR UPDATE, then the expected
-- p_content_hash is compared with the row's CURRENT content_hash. A mismatch
-- (the content changed since the chunks were built) returns
-- {"stale_input": true} and writes NOTHING — stale chunks can never become
-- authoritative, and even a hypothetical stray write stays unreachable because
-- retrieval joins on hash equality. Delete + insert run in the same
-- transaction: the old and new sets never coexist, and a failure rolls back
-- the whole replacement (no partial authoritative write is possible).
create or replace function public.knowledge_reindex_document(
  p_workspace_id uuid,
  p_document_id uuid,
  p_content_hash text,
  p_chunks jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  doc public.knowledge_documents%rowtype;
  res_version integer;
  c jsonb;
  idx integer := 0;
begin
  if jsonb_typeof(coalesce(p_chunks, 'null'::jsonb)) <> 'array'
     or coalesce(btrim(p_content_hash), '') = '' then
    raise exception 'Invalid chunk set.' using errcode = '22023';
  end if;

  -- Workspace boundary + serialisation: lock the document for the whole
  -- replacement. Concurrent indexers and content changes wait here.
  select * into doc from public.knowledge_documents d
   where d.id = p_document_id and d.workspace_id = p_workspace_id
   for update;
  if not found then
    raise exception 'Knowledge document not found.' using errcode = 'P0002', hint = 'document';
  end if;

  -- Stale input: the content changed since these chunks were built. NO write.
  if doc.content_hash is distinct from p_content_hash then
    return jsonb_build_object('stale_input', true, 'replaced', false, 'chunks', 0);
  end if;

  select r.content_version into res_version
    from public.knowledge_resources r
   where r.id = doc.resource_id and r.workspace_id = doc.workspace_id;

  -- Transactional replacement: the old and new chunk sets never coexist.
  delete from public.knowledge_chunks k
   where k.document_id = doc.id and k.workspace_id = doc.workspace_id;

  for c in select e.value from jsonb_array_elements(p_chunks) as e loop
    -- Deterministic complete set: object rows, string content/label, and
    -- chunk_index exactly 0..n-1 in order. Size/shape limits are enforced
    -- again by the table constraints.
    if jsonb_typeof(c) <> 'object'
       or jsonb_typeof(c->'content') <> 'string'
       or jsonb_typeof(c->'source_label') <> 'string'
       or coalesce((c->>'chunk_index')::integer, -1) <> idx then
      raise exception 'Invalid chunk set.' using errcode = '22023';
    end if;
    insert into public.knowledge_chunks
      (workspace_id, resource_id, document_id, chunk_index, content, content_hash, content_version, source_label, heading)
    values
      (doc.workspace_id, doc.resource_id, doc.id, idx,
       c->>'content', doc.content_hash, coalesce(res_version, 0),
       c->>'source_label', c->>'heading');
    idx := idx + 1;
  end loop;

  return jsonb_build_object('stale_input', false, 'replaced', true, 'chunks', idx);
end $$;

-- ---------------------------------------------------- retrieval (server only)
-- Tenant + agent scoped FTS retrieval. The candidate universe is CONSTRUCTED
-- from the agent's own grants BEFORE any ranking:
--
--   workspace → agent → agent_knowledge_resources → assigned resources
--     → ready documents → CURRENT chunks (chunk.content_hash = document.content_hash)
--     → fts @@ websearch_to_tsquery('simple', …) → ts_rank_cd(…, 32) → top K.
--
-- A chunk outside the agent's own workspace/assignments never enters the set,
-- so it can never be ranked or returned. 'searched_chunks' is the universe
-- size, letting the caller distinguish "indexed but no match" (> 0, empty
-- matches) from "nothing currently indexed" (0) for the approved fallback
-- ladder. Top-K is bounded defensively at 20; ordering is deterministic:
-- score DESC, assignment position, document position, chunk_index, chunk id.
create or replace function public.knowledge_match_chunks(
  p_workspace_id uuid,
  p_agent_id uuid,
  p_query text,
  p_top_k integer default 8
) returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  tsq tsquery := websearch_to_tsquery('simple'::regconfig, coalesce(p_query, ''));
  k integer := greatest(1, least(coalesce(p_top_k, 8), 20));
  universe bigint := 0;
  matches jsonb := '[]'::jsonb;
begin
  select count(*) into universe
    from public.agent_knowledge_resources a
    join public.knowledge_resources r
      on r.workspace_id = a.workspace_id and r.id = a.resource_id
    join public.knowledge_documents d
      on d.workspace_id = a.workspace_id and d.resource_id = r.id and d.status = 'ready'
    join public.knowledge_chunks c
      on c.workspace_id = a.workspace_id and c.document_id = d.id
     and c.content_hash = d.content_hash
   where a.workspace_id = p_workspace_id and a.agent_id = p_agent_id;

  if universe > 0 and numnode(tsq) > 0 then
    select coalesce(
             jsonb_agg(jsonb_build_object(
               'resource_id', m.resource_id,
               'document_id', m.document_id,
               'chunk_id', m.chunk_id,
               'chunk_index', m.chunk_index,
               'source_label', m.source_label,
               'heading', m.heading,
               'content', m.content,
               'score', m.score
             ) order by m.score desc, m.assign_pos, m.doc_pos, m.chunk_index, m.chunk_id),
             '[]'::jsonb)
      into matches
      from (
        select c.resource_id, c.document_id, c.id as chunk_id, c.chunk_index,
               c.source_label, c.heading, c.content,
               ts_rank_cd(c.fts, tsq, 32) as score,
               a.position as assign_pos, d.position as doc_pos
          from public.agent_knowledge_resources a
          join public.knowledge_resources r
            on r.workspace_id = a.workspace_id and r.id = a.resource_id
          join public.knowledge_documents d
            on d.workspace_id = a.workspace_id and d.resource_id = r.id and d.status = 'ready'
          join public.knowledge_chunks c
            on c.workspace_id = a.workspace_id and c.document_id = d.id
           and c.content_hash = d.content_hash
         where a.workspace_id = p_workspace_id and a.agent_id = p_agent_id
           and c.fts @@ tsq
         order by score desc, a.position, d.position, c.chunk_index, c.id
         limit k
      ) m;
  end if;

  return jsonb_build_object('searched_chunks', universe, 'matches', matches);
end $$;

-- ------------------------------------------------------------ access control
-- Server-only: no browser role may touch the table or call the functions.
alter table public.knowledge_chunks enable row level security;

revoke all on table public.knowledge_chunks from anon, authenticated;
grant select, insert, update, delete on table public.knowledge_chunks to service_role;

revoke all on function public.knowledge_reindex_document(uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.knowledge_match_chunks(uuid, uuid, text, integer) from public, anon, authenticated;
grant execute on function public.knowledge_reindex_document(uuid, uuid, text, jsonb) to service_role;
grant execute on function public.knowledge_match_chunks(uuid, uuid, text, integer) to service_role;

-- Rollback of THIS migration (manual, only before any chunks matter):
--   drop function if exists public.knowledge_match_chunks(uuid, uuid, text, integer);
--   drop function if exists public.knowledge_reindex_document(uuid, uuid, text, jsonb);
--   drop table if exists public.knowledge_chunks;
--   alter table public.knowledge_documents drop constraint if exists knowledge_documents_ws_res_id_key;
