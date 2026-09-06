-- Pydent — migration 60: per-workspace LiveKit worker token.
-- The deployed Pydent LiveKit worker authenticates to Pydent with this token
-- (generated in Settings → LiveKit; never needs a server env var). Idempotent.
alter table livekit_config add column if not exists worker_token text not null default '';
create index if not exists livekit_config_worker_token_idx on livekit_config (worker_token);
