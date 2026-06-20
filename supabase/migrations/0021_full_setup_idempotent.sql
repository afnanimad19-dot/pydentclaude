-- Pydental — migration 21: FULL idempotent setup. Run ONLY this file.
-- It is safe to run any number of times. It contains NO "on conflict" anywhere,
-- so it CANNOT produce error 42P10. It brings the database to the correct state
-- (multi-tenant foundation + every recent table/column). Missing tables are
-- skipped, so it won't fail if some earlier migration wasn't applied.

-- ── Multi-tenant foundation ────────────────────────────────────────────────
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My clinic',
  created_at timestamptz not null default now()
);
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);
alter table workspaces enable row level security;
alter table profiles enable row level security;
drop policy if exists "own workspace" on workspaces;
create policy "own workspace" on workspaces for select using (id in (select workspace_id from profiles where user_id = auth.uid()));
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function current_workspace() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where user_id = auth.uid()
$$;

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  insert into workspaces (name) values (coalesce(new.email, 'My clinic')) returning id into ws;
  insert into profiles (user_id, workspace_id, email) values (new.id, ws, new.email);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- Give every existing user a workspace.
do $$
declare u record; ws uuid;
begin
  for u in select id, email from auth.users order by created_at loop
    if not exists (select 1 from profiles where user_id = u.id) then
      insert into workspaces (name) values (coalesce(u.email, 'My clinic')) returning id into ws;
      insert into profiles (user_id, workspace_id, email) values (u.id, ws, u.email);
    end if;
  end loop;
end $$;

-- Add workspace_id to every data table that exists, backfill to the primary
-- (oldest) workspace, and default new rows to the caller's workspace.
do $$
declare t text; primary_ws uuid;
  tbls text[] := array[
    'patients','appointments','treatment_plans','treatment_procedures','documents',
    'insurance_policies','payments','agents','channel_defaults','phone_lines',
    'agent_assignments','follow_ups','patient_folders','wa_templates','ig_posts',
    'workflows','tooth_chart_marks','ledger_adjustments','insurance_claims',
    'prescriptions','pipeline_stage_agents','wa_conversations','wa_messages',
    'wa_broadcasts','wa_broadcast_recipients'
  ];
begin
  select p.workspace_id into primary_ws from profiles p join auth.users u on u.id = p.user_id order by u.created_at asc limit 1;
  foreach t in array tbls loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('alter table %I add column if not exists workspace_id uuid references workspaces(id) on delete cascade', t);
      if primary_ws is not null then
        execute format('update %I set workspace_id = %L where workspace_id is null', t, primary_ws);
      end if;
      execute format('alter table %I alter column workspace_id set default current_workspace()', t);
    end if;
  end loop;
end $$;

-- ── Recent features (0015–0019) ────────────────────────────────────────────
create table if not exists opendental_config (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  clinic_api_url text default '',
  clinic_api_key text default '',
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table opendental_config enable row level security;
drop policy if exists "demo open access" on opendental_config;
create policy "demo open access" on opendental_config for all using (true) with check (true);

alter table appointments add column if not exists external_id text;
alter table agents add column if not exists behavior text default '';

-- Dedupe index for inbound messages (won't fail the script if duplicates exist).
do $$
begin
  create unique index if not exists wa_messages_msgid_uniq on wa_messages (wa_message_id) where wa_message_id is not null;
exception when others then null;
end $$;

create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  vapi_call_id text,
  agent_id uuid references agents(id) on delete set null,
  agent_name text default '',
  caller_phone text default '',
  patient_id uuid references patients(id) on delete set null,
  direction text not null default 'inbound',
  status text not null default 'in-progress',
  started_at timestamptz default now(),
  ended_at timestamptz,
  duration_sec int not null default 0,
  transcript text default '',
  summary text default '',
  recording_url text default '',
  outcome text default '',
  created_at timestamptz not null default now()
);
create index if not exists voice_calls_ws_idx on voice_calls (workspace_id, created_at desc);
create index if not exists voice_calls_vapi_idx on voice_calls (vapi_call_id);
alter table voice_calls enable row level security;
drop policy if exists "demo open access" on voice_calls;
create policy "demo open access" on voice_calls for all using (true) with check (true);
