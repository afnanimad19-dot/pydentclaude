-- Durable Meta tokens: store the captured Page token + IG business id so posting
-- survives the short-lived user token. And give workflows a last_fired_at marker
-- for the scheduled "report" trigger. Both idempotent.

alter table if exists public.oauth_tokens
  add column if not exists meta jsonb;

alter table if exists public.workflows
  add column if not exists last_fired_at timestamptz;
