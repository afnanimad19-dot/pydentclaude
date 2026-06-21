-- Pydent — migration 26: per-clinic integrations/connections.
-- Each clinic (workspace) connects ITS OWN Google/marketing accounts via OAuth.
-- The single OAuth *app* credentials live in env vars (the developer's app);
-- each clinic's tokens are stored here per workspace — never shared across clinics.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

-- Connection status (safe to read in the dashboard): which providers a clinic has
-- connected and the account label. NO secrets here.
create table if not exists connections (
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  provider text not null,
  status text not null default 'connected',
  account_label text default '',
  connected_at timestamptz not null default now(),
  primary key (workspace_id, provider)
);
alter table connections enable row level security;
drop policy if exists "demo open access" on connections;
create policy "demo open access" on connections for all using (true) with check (true);

-- OAuth tokens (secrets) — per workspace + provider. NO RLS policy is created, so
-- the anon/public key cannot read it; only the server-side service-role key can.
create table if not exists oauth_tokens (
  workspace_id uuid not null,
  provider text not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider)
);
alter table oauth_tokens enable row level security;
