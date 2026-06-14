-- Pydental — migration 7: WhatsApp Business (Meta Cloud API) connection.
-- Stores the per-clinic credentials entered on Settings → WhatsApp connection.
-- Run in Supabase Dashboard → SQL Editor.

create table if not exists whatsapp_config (
  workspace text primary key default 'default',
  display_number text default '',     -- the human-readable number, for display
  phone_number_id text default '',     -- Meta "Phone Number ID"
  waba_id text default '',             -- WhatsApp Business Account ID
  access_token text default '',        -- permanent access token (see note below)
  verify_token text default '',        -- custom token, must match Meta webhook config
  pin text default '',                 -- two-step verification PIN
  connected boolean not null default false,
  updated_at timestamptz not null default now()
);

-- NOTE: in production the access_token should be encrypted at rest (AES-256-GCM)
-- and only handled server-side. This demo-open policy mirrors the rest of the
-- schema; tighten RLS + add encryption before storing real Meta tokens.
alter table whatsapp_config enable row level security;
drop policy if exists "demo open access" on whatsapp_config;
create policy "demo open access" on whatsapp_config for all using (true) with check (true);
