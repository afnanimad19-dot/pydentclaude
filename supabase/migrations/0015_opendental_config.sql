-- Pydental — migration 15: Open Dental connection (per workspace). Stores ONLY
-- the clinic middleware URL + shared key — never any patient/clinical data.
-- Run in Supabase Dashboard → SQL Editor.

create table if not exists opendental_config (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  clinic_api_url text default '',     -- Cloudflare Tunnel URL of the clinic's local middleware
  clinic_api_key text default '',     -- shared secret for the middleware
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table opendental_config enable row level security;
drop policy if exists "demo open access" on opendental_config;
create policy "demo open access" on opendental_config for all using (true) with check (true);
