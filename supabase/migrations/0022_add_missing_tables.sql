-- Pydental — migration 22: adds ONLY the two tables that were missing
-- (opendental_config, voice_calls) plus the behavior column, external_id and the
-- message-dedupe index. No ON CONFLICT, no function dependency — cannot 42P10.
-- Run this in a fresh SQL tab. Do NOT run the old "Core Schema and Demo Seed" query.

create table if not exists opendental_config (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  clinic_api_url text default '',
  clinic_api_key text default '',
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table opendental_config enable row level security;
drop policy if exists "demo open access" on opendental_config;
create policy "demo open access" on opendental_config for all using (true) with check (true);

alter table agents add column if not exists behavior text default '';
alter table appointments add column if not exists external_id text;

do $$ begin
  create unique index if not exists wa_messages_msgid_uniq
    on wa_messages (wa_message_id) where wa_message_id is not null;
exception when others then null; end $$;

create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
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
