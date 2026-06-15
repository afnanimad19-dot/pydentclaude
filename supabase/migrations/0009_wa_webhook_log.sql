-- Pydental — migration 9: WhatsApp webhook activity log (diagnostics).
-- Lets Settings → WhatsApp show whether Meta is actually calling the webhook.
-- Run in Supabase Dashboard → SQL Editor.

create table if not exists wa_webhook_events (
  id uuid primary key default gen_random_uuid(),
  summary text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists wa_webhook_events_created_idx on wa_webhook_events (created_at desc);

alter table wa_webhook_events enable row level security;
drop policy if exists "demo open access" on wa_webhook_events;
create policy "demo open access" on wa_webhook_events for all using (true) with check (true);
