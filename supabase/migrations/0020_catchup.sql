-- Pydental — migration 20: CATCH-UP. Safe to run once (idempotent). Contains
-- everything from 0015–0019 so you don't have to run those individually.
-- Requires 0014 (multi-tenant) to have been applied. Run in Supabase SQL Editor.

-- Make sure the helper exists (used as a column default).
create or replace function current_workspace() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where user_id = auth.uid()
$$;

-- 0015 — Open Dental connection (per workspace)
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

-- 0016 — Open Dental appointment id on our calendar rows
alter table appointments add column if not exists external_id text;

-- 0017 — separate agent behavior box
alter table agents add column if not exists behavior text default '';

-- 0018 — dedupe inbound messages (stops the agent replying twice on Meta retries)
create unique index if not exists wa_messages_msgid_uniq
  on wa_messages (wa_message_id) where wa_message_id is not null;

-- 0019 — live voice calls (Vapi)
create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  vapi_call_id text,
  agent_id uuid references agents(id) on delete set null,
  agent_name text default '',
  caller_phone text default '',
  patient_id uuid references patients(id) on delete set null,
  direction text not null default 'inbound',
  status text not null default 'in-progress' check (status in ('in-progress','ended','failed')),
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
