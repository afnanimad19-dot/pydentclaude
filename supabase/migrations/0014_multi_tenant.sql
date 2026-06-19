-- Pydental — migration 14: multi-tenant. Each clinic gets its own workspace; all
-- data is scoped to a workspace. New signups get an empty workspace automatically;
-- existing data is assigned to the primary (oldest) account. Run in Supabase SQL Editor.

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

-- The caller's workspace (used as the default workspace_id on inserts).
create or replace function current_workspace() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where user_id = auth.uid()
$$;

-- Auto-create a workspace + profile for each new signup.
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

-- Backfill: give every existing user a workspace + profile.
do $$
declare u record; ws uuid;
begin
  for u in select id, email, created_at from auth.users order by created_at loop
    if not exists (select 1 from profiles where user_id = u.id) then
      insert into workspaces (name) values (coalesce(u.email, 'My clinic')) returning id into ws;
      insert into profiles (user_id, workspace_id, email) values (u.id, ws, u.email);
    end if;
  end loop;
end $$;

-- Add workspace_id to every data table, backfill existing rows to the primary
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
    execute format('alter table %I add column if not exists workspace_id uuid references workspaces(id) on delete cascade', t);
    if primary_ws is not null then
      execute format('update %I set workspace_id = %L where workspace_id is null', t, primary_ws);
    end if;
    execute format('alter table %I alter column workspace_id set default current_workspace()', t);
  end loop;
end $$;

-- Replace global unique constraints with per-workspace ones (two clinics may both
-- have a "whatsapp" default, a folder named "VIP", the same contact, etc.).
alter table channel_defaults drop constraint if exists channel_defaults_channel_key;
create unique index if not exists channel_defaults_ws_channel on channel_defaults (workspace_id, channel);

alter table phone_lines drop constraint if exists phone_lines_number_key;
create unique index if not exists phone_lines_ws_number on phone_lines (workspace_id, number);

alter table patient_folders drop constraint if exists patient_folders_name_key;
create unique index if not exists patient_folders_ws_name on patient_folders (workspace_id, name);

alter table wa_conversations drop constraint if exists wa_conversations_contact_phone_key;
create unique index if not exists wa_conversations_ws_contact on wa_conversations (workspace_id, contact_phone, channel);

-- pipeline_stage_agents was keyed only by stage_id; key it per workspace.
alter table pipeline_stage_agents drop constraint if exists pipeline_stage_agents_pkey;
create unique index if not exists pipeline_stage_agents_ws_stage on pipeline_stage_agents (workspace_id, stage_id);

-- whatsapp_config is keyed by the text "workspace" column. Re-point the existing
-- single "default" row to the primary workspace id, and add the routing columns'
-- index so the webhook can find a clinic by its phone number.
do $$
declare primary_ws uuid;
begin
  select p.workspace_id into primary_ws from profiles p join auth.users u on u.id = p.user_id order by u.created_at asc limit 1;
  if primary_ws is not null then
    update whatsapp_config set workspace = primary_ws::text where workspace = 'default';
  end if;
end $$;
create index if not exists whatsapp_config_phone_idx on whatsapp_config (phone_number_id);
create index if not exists whatsapp_config_page_idx on whatsapp_config (page_id);
