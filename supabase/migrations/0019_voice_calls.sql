-- Pydental — migration 19: live voice calls (Vapi). Transcripts, recordings and
-- summaries land here from the Vapi webhook. Run in Supabase SQL Editor.

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
