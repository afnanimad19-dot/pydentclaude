-- Pydent — migration 25: per-clinic settings (currently just the website URL).
-- Used so agents can pull knowledge straight from the clinic's own website.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

create table if not exists clinic_settings (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  website text default '',
  updated_at timestamptz not null default now()
);
alter table clinic_settings enable row level security;
drop policy if exists "demo open access" on clinic_settings;
create policy "demo open access" on clinic_settings for all using (true) with check (true);
