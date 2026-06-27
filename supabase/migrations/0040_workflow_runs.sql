-- Pydent — migration 40: workflow execution runs. The Workflows runner persists
-- one row per in-flight run so multi-step flows with waits survive across cron
-- ticks. Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  workflow_id uuid references workflows(id) on delete cascade,
  patient_id uuid,
  conversation_id uuid,
  channel text default 'whatsapp',
  contact_phone text default '',
  status text not null default 'running',   -- running | waiting | done | failed
  node_index int not null default 0,
  resume_at timestamptz,
  vars jsonb default '{}'::jsonb,
  log jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflow_runs_resume_idx on workflow_runs (status, resume_at);

alter table workflow_runs enable row level security;
do $$ begin
  create policy workflow_runs_all on workflow_runs for all using (true) with check (true);
exception when duplicate_object then null; end $$;
