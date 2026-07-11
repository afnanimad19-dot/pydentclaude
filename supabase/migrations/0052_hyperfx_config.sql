-- Pydental — migration 52: per-workspace Hyperfx.ai credentials.
-- Multi-clinic model: each clinic (workspace) can have its OWN Hyperfx
-- account/sub-account (enterprise plan), so its connected ad/SEO/calendar
-- platforms are isolated from every other clinic's. Falls back to the global
-- HYPERFX_MCP_URL / HYPERFX_API_KEY env vars when a workspace has no row.

create table if not exists hyperfx_config (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  mcp_url text default '',
  api_key text default '',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table hyperfx_config enable row level security;
drop policy if exists "workspace isolation" on hyperfx_config;
create policy "workspace isolation" on hyperfx_config
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
