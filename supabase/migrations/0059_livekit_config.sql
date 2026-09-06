-- Pydent — migration 59: LiveKit voice engine (replaces xAI Grok Voice).
--
-- Per-workspace LiveKit Cloud credentials so each clinic can run its voice
-- agents on its own LiveKit project (falls back to LIVEKIT_URL / LIVEKIT_API_KEY
-- / LIVEKIT_API_SECRET env vars when a clinic hasn't set its own). The secret
-- is write-only in the UI. Idempotent.

create table if not exists livekit_config (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  url text not null default '',          -- wss://<project>.livekit.cloud
  api_key text not null default '',
  api_secret text not null default '',
  agent_name text not null default 'pydent-agent', -- deployed worker's agent name (explicit dispatch)
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table livekit_config enable row level security;
drop policy if exists "workspace livekit config" on livekit_config;
create policy "workspace livekit config" on livekit_config
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());

-- Call logs: which engine took the call (vapi / livekit) — shown as a tag.
alter table voice_calls add column if not exists engine text not null default 'vapi';
create index if not exists voice_calls_engine_idx on voice_calls (workspace_id, engine);

-- Existing "xai" engine preference rows become LiveKit.
update connections set account_label = 'livekit' where provider = 'voice_engine' and account_label = 'xai';
