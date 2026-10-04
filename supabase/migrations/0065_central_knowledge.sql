-- Pydent — migration 65: Central Knowledge Base (Phase A schema).
--
-- Additive only. Creates three NEW tables (plus their triggers and two
-- server-only write functions) and nothing else:
--
--   knowledge_resources        a central resource (one card: a File or URL resource)
--   knowledge_documents        the documents inside a resource (one per file / per URL added)
--   agent_knowledge_resources  which agents use which resources (assignment links)
--
--   knowledge_apply_document_changes  document changes + content_version, atomically
--   knowledge_duplicate_resource      resource + all documents copied, atomically
--
-- It does NOT alter `agents` or any other existing table, column, index or
-- policy, and nothing in the agent runtime reads these tables yet — existing
-- agents keep using agents.knowledge_base / kb_files exactly as before.
--
-- Access model (deny-all for the browser): RLS is enabled on all three tables
-- with NO policies, and the anon / authenticated roles have no table grants.
-- Every read and write goes through authenticated server APIs using the
-- service role (which bypasses RLS) and filters by the session's workspace.
--
-- Integrity guaranteed by the database itself:
--   • a document always belongs to a resource in the SAME workspace, and its
--     kind matches the resource type (composite foreign keys);
--   • an assignment links an agent and a resource of the SAME workspace
--     (composite foreign key for the resource + validation trigger for the agent);
--   • a resource that is assigned to any agent cannot be deleted
--     (ON DELETE NO ACTION) — unassign first;
--   • deleting an agent removes only its assignment links, never a resource;
--   • deleting a resource removes its documents;
--   • deleting a workspace removes all of its Central KB data;
--   • a document change and its content_version increment, and a resource
--     duplicate (resource + all documents), are each ONE transaction
--     (server-only functions below).
--
-- Idempotent where practical: IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS.

-- ------------------------------------------------------------ resources
create table if not exists public.knowledge_resources (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  name text not null,
  description text not null default '',
  type text not null,
  status text not null default 'empty',
  refresh_enabled boolean not null default false,
  refresh_interval_hours integer,
  next_refresh_at timestamptz,
  last_refreshed_at timestamptz,
  last_error text,
  content_version integer not null default 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_resources_name_chk check (char_length(btrim(name)) between 1 and 80),
  constraint knowledge_resources_type_chk check (type in ('file', 'url')),
  constraint knowledge_resources_status_chk check (status in ('empty', 'processing', 'ready', 'error')),
  constraint knowledge_resources_refresh_interval_chk check (refresh_interval_hours is null or refresh_interval_hours in (6, 12, 24, 168)),
  constraint knowledge_resources_content_version_chk check (content_version >= 0),
  -- Targets for the composite foreign keys below (workspace-safe references).
  constraint knowledge_resources_ws_id_key unique (workspace_id, id),
  constraint knowledge_resources_ws_id_type_key unique (workspace_id, id, type)
);

-- One resource name per workspace (case-insensitive).
create unique index if not exists knowledge_resources_ws_name_uniq
  on public.knowledge_resources (workspace_id, lower(btrim(name)));
create index if not exists knowledge_resources_ws_updated_idx
  on public.knowledge_resources (workspace_id, updated_at desc);

-- ------------------------------------------------------------ documents
create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  resource_id uuid not null,
  kind text not null,
  source_url text,
  filename text,
  mime text,
  storage_path text,                                   -- reserved; no original files are stored in Phase A
  content text not null default '',
  content_hash text,
  char_count integer generated always as (char_length(content)) stored,
  fetched_at timestamptz,
  status text not null default 'processing',
  error text,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_documents_kind_chk check (kind in ('file', 'url')),
  constraint knowledge_documents_status_chk check (status in ('processing', 'ready', 'error')),
  constraint knowledge_documents_source_chk check (
    (kind = 'file' and filename is not null and char_length(btrim(filename)) > 0)
    or (kind = 'url' and source_url is not null and char_length(btrim(source_url)) > 0)
  ),
  constraint knowledge_documents_content_len_chk check (char_length(content) <= 200000),
  constraint knowledge_documents_position_chk check (position >= 0),
  -- The document's resource is in the SAME workspace and of the SAME type
  -- (file documents only in File resources, url documents only in URL resources).
  -- Deleting the resource deletes its documents.
  constraint knowledge_documents_resource_fk foreign key (workspace_id, resource_id, kind)
    references public.knowledge_resources (workspace_id, id, type) on delete cascade
);

-- A file name / URL appears at most once per resource (re-upload replaces in place).
create unique index if not exists knowledge_documents_file_uniq
  on public.knowledge_documents (resource_id, lower(btrim(filename))) where kind = 'file';
create unique index if not exists knowledge_documents_url_uniq
  on public.knowledge_documents (resource_id, source_url) where kind = 'url';
create index if not exists knowledge_documents_resource_pos_idx
  on public.knowledge_documents (resource_id, position);
create index if not exists knowledge_documents_ws_idx
  on public.knowledge_documents (workspace_id);

-- ------------------------------------------------------------ assignments
create table if not exists public.agent_knowledge_resources (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Deleting an agent removes only its links — never the shared resource.
  agent_id uuid not null references public.agents(id) on delete cascade,
  resource_id uuid not null,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  constraint agent_knowledge_resources_pkey primary key (agent_id, resource_id),
  constraint agent_knowledge_resources_position_chk check (position >= 0),
  -- Same-workspace resource. NO ACTION (checked at the end of the statement):
  -- deleting an assigned resource is refused, while deleting a whole workspace
  -- (which cascades to both the links and the resources) still succeeds.
  constraint agent_knowledge_resources_resource_fk foreign key (workspace_id, resource_id)
    references public.knowledge_resources (workspace_id, id) on delete no action
);

create index if not exists agent_knowledge_resources_resource_idx
  on public.agent_knowledge_resources (resource_id);
create index if not exists agent_knowledge_resources_ws_agent_idx
  on public.agent_knowledge_resources (workspace_id, agent_id);

-- ------------------------------------------------------------ triggers
-- The assigned agent must belong to the assignment's workspace. (A trigger, so
-- the agents table needs no new key — agents is not altered.)
create or replace function public.agent_knowledge_resources_check_ws() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1 from public.agents a where a.id = new.agent_id and a.workspace_id = new.workspace_id
  ) then
    raise exception 'Knowledge assignment refused: the agent does not belong to this workspace.'
      using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists agent_knowledge_resources_check_ws on public.agent_knowledge_resources;
create trigger agent_knowledge_resources_check_ws
  before insert or update on public.agent_knowledge_resources
  for each row execute function public.agent_knowledge_resources_check_ws();

-- At most 50 documents per resource. The parent row is locked first so two
-- concurrent inserts cannot both pass the count.
create or replace function public.knowledge_documents_limit() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  perform 1 from public.knowledge_resources r where r.id = new.resource_id for update;
  if (select count(*) from public.knowledge_documents d where d.resource_id = new.resource_id) >= 50 then
    raise exception 'A knowledge resource can hold at most 50 documents.' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists knowledge_documents_limit on public.knowledge_documents;
create trigger knowledge_documents_limit
  before insert on public.knowledge_documents
  for each row execute function public.knowledge_documents_limit();

-- updated_at maintenance.
create or replace function public.knowledge_touch_updated_at() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists knowledge_resources_touch on public.knowledge_resources;
create trigger knowledge_resources_touch
  before update on public.knowledge_resources
  for each row execute function public.knowledge_touch_updated_at();

drop trigger if exists knowledge_documents_touch on public.knowledge_documents;
create trigger knowledge_documents_touch
  before update on public.knowledge_documents
  for each row execute function public.knowledge_touch_updated_at();

-- ------------------------------------------------------------ atomic write functions (server only)
-- Every change to a resource's effective knowledge goes through ONE of these
-- two functions, so each logical operation is a single PostgreSQL transaction:
-- it either fully applies or leaves nothing behind.
--
-- The server (TypeScript) owns every business decision — validation, hashing,
-- same-file / same-URL planning, copy naming — and sends the result here. These
-- functions only persist it atomically and enforce integrity: workspace
-- boundaries, the resource lock, and the content_version increment.
--
-- SECURITY INVOKER (the default) on purpose: the only caller is the service
-- role, which already has table access, so no privilege elevation is needed. A
-- caller without table privileges gets nothing from these functions. EXECUTE is
-- revoked from PUBLIC / anon / authenticated and granted only to service_role
-- (below). `search_path = ''` and schema-qualified names prevent any object
-- substitution through the search path.
--
-- Not authorization: the server route has already checked the session user's
-- workspace and role. The functions still refuse anything outside the supplied
-- workspace (an id from another workspace behaves as not found).

-- Apply one logical operation's document changes to ONE resource, then
-- re-derive the resource status and increment content_version at most once.
--
-- p_changes: JSON array of operations, applied in order:
--   {"op":"insert",  "kind","filename","source_url","mime","content","content_hash","fetched_at","status","error","position"}
--   {"op":"replace", "id", "mime","content","content_hash","fetched_at","status","error"}   new content for an existing document
--   {"op":"touch",   "id", ["fetched_at"], ["error"]}                                         metadata only; never content
--   {"op":"delete",  "id"}
--   replace / touch / delete may carry "optional": true — a document that no
--   longer exists is then skipped (reported "applied": false) instead of
--   failing the whole operation.
-- p_resource: optional {"last_error", "last_refreshed_at"} (only keys present are written).
--
-- content_version: +1 (database-side, under the row lock) when the operation
-- inserted or deleted a document or actually changed a document's content or
-- status; +0 otherwise.
create or replace function public.knowledge_apply_document_changes(
  p_workspace_id uuid,
  p_resource_id uuid,
  p_user_id uuid,
  p_changes jsonb,
  p_resource jsonb default '{}'::jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  res public.knowledge_resources%rowtype;
  old_doc public.knowledge_documents%rowtype;
  c jsonb;
  op text;
  doc_id uuid;
  did_change boolean := false;
  results jsonb := '[]'::jsonb;
begin
  if jsonb_typeof(coalesce(p_changes, '[]'::jsonb)) <> 'array' or jsonb_typeof(coalesce(p_resource, '{}'::jsonb)) <> 'object' then
    raise exception 'Invalid knowledge change set.' using errcode = '22023';
  end if;

  -- Workspace boundary + serialisation: lock the resource row for the whole
  -- operation. Concurrent operations on the same resource wait here.
  select * into res from public.knowledge_resources k
   where k.id = p_resource_id and k.workspace_id = p_workspace_id
   for update;
  if not found then
    raise exception 'Knowledge resource not found.' using errcode = 'P0002', hint = 'resource';
  end if;

  for c in select e.value from jsonb_array_elements(coalesce(p_changes, '[]'::jsonb)) as e loop
    op := c->>'op';
    doc_id := null;
    if op = 'insert' then
      -- workspace_id / resource_id come from the parameters, never the payload.
      insert into public.knowledge_documents
        (workspace_id, resource_id, kind, source_url, filename, mime, content, content_hash, fetched_at, status, error, position)
      values
        (p_workspace_id, p_resource_id, c->>'kind', c->>'source_url', c->>'filename', c->>'mime',
         coalesce(c->>'content', ''), c->>'content_hash', (c->>'fetched_at')::timestamptz,
         coalesce(c->>'status', 'ready'), c->>'error', coalesce((c->>'position')::integer, 0))
      returning id into doc_id;
      did_change := true;
    elsif op in ('replace', 'touch', 'delete') then
      select * into old_doc from public.knowledge_documents d
       where d.id = (c->>'id')::uuid and d.resource_id = p_resource_id and d.workspace_id = p_workspace_id
       for update;
      if not found then
        if coalesce((c->>'optional')::boolean, false) then
          results := results || jsonb_build_array(jsonb_build_object('op', op, 'id', c->>'id', 'applied', false));
          continue;
        end if;
        raise exception 'Knowledge document not found.' using errcode = 'P0002', hint = 'document';
      end if;
      doc_id := old_doc.id;
      if op = 'replace' then
        update public.knowledge_documents d set
          mime = c->>'mime',
          content = coalesce(c->>'content', ''),
          content_hash = c->>'content_hash',
          fetched_at = (c->>'fetched_at')::timestamptz,
          status = coalesce(c->>'status', 'ready'),
          error = c->>'error'
         where d.id = old_doc.id;
        if old_doc.content is distinct from coalesce(c->>'content', '')
           or old_doc.status is distinct from coalesce(c->>'status', 'ready') then
          did_change := true;
        end if;
      elsif op = 'touch' then
        update public.knowledge_documents d set
          fetched_at = case when c ? 'fetched_at' then (c->>'fetched_at')::timestamptz else d.fetched_at end,
          error = case when c ? 'error' then c->>'error' else d.error end
         where d.id = old_doc.id;
      else
        delete from public.knowledge_documents d where d.id = old_doc.id;
        did_change := true;
      end if;
    else
      raise exception 'Unknown knowledge change.' using errcode = '22023';
    end if;
    results := results || jsonb_build_array(jsonb_build_object('op', op, 'id', doc_id, 'applied', true));
  end loop;

  update public.knowledge_resources k set
    status = (
      select case
               when count(*) = 0 then 'empty'
               when bool_or(d.status = 'processing') then 'processing'
               when bool_or(d.status = 'ready') then 'ready'
               else 'error'
             end
        from public.knowledge_documents d
       where d.resource_id = k.id and d.workspace_id = k.workspace_id
    ),
    content_version = k.content_version + case when did_change then 1 else 0 end,
    updated_by = p_user_id,
    last_error = case when coalesce(p_resource, '{}'::jsonb) ? 'last_error' then p_resource->>'last_error' else k.last_error end,
    last_refreshed_at = case when coalesce(p_resource, '{}'::jsonb) ? 'last_refreshed_at' then (p_resource->>'last_refreshed_at')::timestamptz else k.last_refreshed_at end
   where k.id = res.id and k.workspace_id = p_workspace_id
  returning * into res;

  return jsonb_build_object('resource', to_jsonb(res), 'changed', did_change, 'results', results);
end $$;

-- Duplicate a resource and ALL of its documents in one transaction. The new
-- name is the collision-safe copy name computed by the server (copyName); the
-- name check and unique index still apply. Documents get NEW ids and keep their
-- order (positions renumbered 0..n-1). Agent assignments are NOT copied. The
-- source is only read (share-locked so no change can interleave with the copy).
create or replace function public.knowledge_duplicate_resource(
  p_workspace_id uuid,
  p_source_id uuid,
  p_name text,
  p_user_id uuid
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  src public.knowledge_resources%rowtype;
  dst public.knowledge_resources%rowtype;
  copied integer;
begin
  select * into src from public.knowledge_resources k
   where k.id = p_source_id and k.workspace_id = p_workspace_id
   for share;
  if not found then
    raise exception 'Knowledge resource not found.' using errcode = 'P0002', hint = 'resource';
  end if;

  insert into public.knowledge_resources
    (workspace_id, name, description, type, status, refresh_enabled, refresh_interval_hours, content_version, created_by, updated_by)
  values
    (p_workspace_id, btrim(p_name), src.description, src.type, 'empty', src.refresh_enabled, src.refresh_interval_hours, 0, p_user_id, p_user_id)
  returning * into dst;

  insert into public.knowledge_documents
    (workspace_id, resource_id, kind, source_url, filename, mime, content, content_hash, fetched_at, status, error, position)
  select p_workspace_id, dst.id, d.kind, d.source_url, d.filename, d.mime, d.content, d.content_hash, d.fetched_at, d.status, d.error,
         (row_number() over (order by d.position, d.created_at, d.id) - 1)::integer
    from public.knowledge_documents d
   where d.resource_id = src.id and d.workspace_id = p_workspace_id;
  get diagnostics copied = row_count;

  update public.knowledge_resources k set
    status = (
      select case
               when count(*) = 0 then 'empty'
               when bool_or(d.status = 'processing') then 'processing'
               when bool_or(d.status = 'ready') then 'ready'
               else 'error'
             end
        from public.knowledge_documents d
       where d.resource_id = k.id and d.workspace_id = k.workspace_id
    ),
    content_version = case when copied > 0 then 1 else 0 end
   where k.id = dst.id and k.workspace_id = p_workspace_id
  returning * into dst;

  return jsonb_build_object('resource', to_jsonb(dst), 'documents', copied);
end $$;

-- Server-only: no browser role may call them.
revoke all on function public.knowledge_apply_document_changes(uuid, uuid, uuid, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.knowledge_duplicate_resource(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.knowledge_apply_document_changes(uuid, uuid, uuid, jsonb, jsonb) to service_role;
grant execute on function public.knowledge_duplicate_resource(uuid, uuid, text, uuid) to service_role;

-- ------------------------------------------------------------ access: deny-all for the browser
-- RLS on, NO policies: the anon / authenticated keys can neither read nor write.
-- The table grants are revoked as well (belt and braces). The service role is
-- unaffected and is the only path in (authenticated server APIs).
alter table public.knowledge_resources enable row level security;
alter table public.knowledge_documents enable row level security;
alter table public.agent_knowledge_resources enable row level security;

revoke all on table public.knowledge_resources from anon, authenticated;
revoke all on table public.knowledge_documents from anon, authenticated;
revoke all on table public.agent_knowledge_resources from anon, authenticated;

-- Rollback of THIS migration (manual, only before any Central KB data matters):
--   drop function if exists public.knowledge_apply_document_changes(uuid, uuid, uuid, jsonb, jsonb);
--   drop function if exists public.knowledge_duplicate_resource(uuid, uuid, text, uuid);
--   drop table if exists public.agent_knowledge_resources;
--   drop table if exists public.knowledge_documents;
--   drop table if exists public.knowledge_resources;
--   drop function if exists public.agent_knowledge_resources_check_ws();
--   drop function if exists public.knowledge_documents_limit();
--   drop function if exists public.knowledge_touch_updated_at();
