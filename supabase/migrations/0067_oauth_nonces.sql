-- Pydent — migration 67: GC-1 OAuth replay-prevention nonce ledger
-- (PROPOSED — NOT YET APPLIED TO ANY ENVIRONMENT; review and apply manually
-- in the Supabase SQL editor. The Google connect flow FAILS CLOSED — refuses
-- to start — until this table exists, by design.)
--
-- One row per OAuth begin. The callback consumes the row with a single atomic
-- UPDATE (… WHERE consumed_at IS NULL AND expires_at > now), so a captured
-- state value can be redeemed at most once, across all Netlify serverless
-- instances — no in-memory cache is involved anywhere.
--
-- Security properties:
--  * RLS is enabled with NO policies: the anon/publishable key can neither
--    read nor write rows; only the service-role server client touches them
--    (same posture as oauth_tokens).
--  * Rows contain no secrets: the nonce is a random single-use handle, bound
--    to the workspace + provider minted into the HMAC-signed state, and the
--    callback cross-checks that binding.
--  * Rows expire in minutes (state TTL); long-expired rows are deleted
--    opportunistically by the callback.
--
-- Risk assessment: purely additive; no existing table or policy changes.
-- Idempotent — safe to re-run. Rollback: `drop table if exists oauth_nonces;`

create table if not exists oauth_nonces (
  nonce text primary key,
  workspace_id uuid not null,
  provider text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create index if not exists oauth_nonces_expires_idx on oauth_nonces (expires_at);

alter table oauth_nonces enable row level security;
-- Deliberately NO policies: deny-all for anon/authenticated; service-role only.
