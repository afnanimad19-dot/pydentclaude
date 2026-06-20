-- Pydental — migration 24: voice library + custom (cloned) voices.
-- A clinic can pick a premade voice OR record their own to clone it (managed TTS,
-- e.g. ElevenLabs). Custom voices are stored per-workspace here; premade voices
-- come live from the provider. The chosen voice id is saved on the agent.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

create table if not exists voices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  voice_id text not null,                 -- provider (e.g. ElevenLabs) voice id
  name text not null default 'Custom voice',
  gender text default '',
  accent text default '',
  provider text not null default '11labs',
  created_at timestamptz not null default now()
);
create index if not exists voices_ws_idx on voices (workspace_id);
alter table voices enable row level security;
drop policy if exists "demo open access" on voices;
create policy "demo open access" on voices for all using (true) with check (true);

-- The provider voice id selected for a voice agent (premade or cloned).
alter table agents add column if not exists voice_id text;
