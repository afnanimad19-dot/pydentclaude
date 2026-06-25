-- Pydent — migration 31: downloadable reports + per-agent activity feed.
-- reports: a report an agent generated, served as DOCX/HTML on demand and shown
--   in the agent's Documents panel.
-- agent_activity: a log of what each agent did (published a blog, posted, pulled
--   a report, etc.) shown in the agent's Activity feed. Idempotent.

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text default '',
  title text not null default 'Report',
  content_md text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists reports_ws_idx on reports (workspace_id, created_at desc);
alter table reports enable row level security;
drop policy if exists "demo open access" on reports;
create policy "demo open access" on reports for all using (true) with check (true);

create table if not exists agent_activity (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text not null,
  action text not null,
  detail text default '',
  link text default '',
  created_at timestamptz not null default now()
);
create index if not exists agent_activity_idx on agent_activity (workspace_id, agent_key, created_at desc);
alter table agent_activity enable row level security;
drop policy if exists "demo open access" on agent_activity;
create policy "demo open access" on agent_activity for all using (true) with check (true);
