-- Pydent — migration 32: AI Team autopilot (scheduled recurring tasks).
-- e.g. "every Monday, write & draft a blog", "daily, draft an Instagram post".
-- A cron hits /api/cron/run which executes due tasks via the agent and reschedules.
-- Idempotent.

create table if not exists scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text not null,
  title text default '',
  instruction text not null,
  cadence text not null default 'weekly',     -- daily | weekly | monthly
  next_run timestamptz not null default now(),
  status text not null default 'active',       -- active | paused
  last_run timestamptz,
  last_result text default '',
  created_at timestamptz not null default now()
);
create index if not exists scheduled_tasks_due_idx on scheduled_tasks (status, next_run);
create index if not exists scheduled_tasks_ws_idx on scheduled_tasks (workspace_id, agent_key);
alter table scheduled_tasks enable row level security;
drop policy if exists "demo open access" on scheduled_tasks;
create policy "demo open access" on scheduled_tasks for all using (true) with check (true);
