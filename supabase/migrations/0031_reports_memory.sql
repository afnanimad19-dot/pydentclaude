-- Pydent — migration 31: downloadable reports + clinic memory (Remy).
-- reports: a saved report an agent generated, served as DOCX/HTML on demand.
-- clinic_memory: facts the team teaches the clinic's AI ("we run a July whitening
-- promo", "new hygienist Dr. X") that agents can recall. Idempotent.

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

create table if not exists clinic_memory (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  note text not null,
  tag text default '',
  created_at timestamptz not null default now()
);
create index if not exists clinic_memory_ws_idx on clinic_memory (workspace_id, created_at desc);
alter table clinic_memory enable row level security;
drop policy if exists "demo open access" on clinic_memory;
create policy "demo open access" on clinic_memory for all using (true) with check (true);
