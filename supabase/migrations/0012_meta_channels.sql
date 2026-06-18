-- Pydental — migration 12: Instagram + Facebook Messenger inbound.
-- Reuses the live-inbox tables with a channel column, and stores the Meta Page /
-- Instagram credentials. Run in Supabase Dashboard → SQL Editor.

alter table wa_conversations
  add column if not exists channel text not null default 'whatsapp';

-- Page (Messenger) + Instagram credentials live alongside the WhatsApp config —
-- it's the same Meta app and webhook.
alter table whatsapp_config add column if not exists page_id text default '';
alter table whatsapp_config add column if not exists page_access_token text default '';
alter table whatsapp_config add column if not exists ig_id text default '';
