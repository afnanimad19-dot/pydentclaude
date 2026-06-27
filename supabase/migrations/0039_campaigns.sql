-- Pydent — migration 39: voice calling campaigns (the connective layer for the
-- Voice Agents tab — ties an agent + a phone number + a contact list together,
-- and lets Call Logs show/filter by campaign). Run in Supabase SQL Editor.
-- Idempotent, no ON CONFLICT.

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  name text not null default '',
  agent_id uuid references agents(id) on delete set null,
  number_id uuid references voice_numbers(id) on delete set null,
  folder_id uuid,                 -- optional contact list (patient_folders.id)
  direction text not null default 'outbound',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- Which campaign a logged call belongs to.
alter table voice_calls add column if not exists campaign_id uuid;

-- Demo-open RLS like the rest of the app (isolation is app-level via workspace_id).
alter table campaigns enable row level security;
do $$ begin
  create policy campaigns_all on campaigns for all using (true) with check (true);
exception when duplicate_object then null; end $$;
