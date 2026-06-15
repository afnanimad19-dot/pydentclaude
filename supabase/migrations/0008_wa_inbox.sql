-- Pydental — migration 8: live WhatsApp inbox.
-- Inbound messages from the Meta webhook land here and show in the Omnichannel
-- Inbox. Run in Supabase Dashboard → SQL Editor.

create table if not exists wa_conversations (
  id uuid primary key default gen_random_uuid(),
  contact_phone text not null unique,       -- E.164 wa_id, e.g. 15551234567
  contact_name text default '',
  last_message text default '',
  last_time timestamptz not null default now(),
  unread int not null default 0,
  assigned_agent_id uuid references agents(id) on delete set null,
  lifecycle text not null default 'New Lead',
  status text not null default 'open',       -- open | closed
  created_at timestamptz not null default now()
);

create table if not exists wa_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references wa_conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')),
  author text default '',
  body text default '',
  by_bot boolean not null default false,
  wa_message_id text,                        -- Meta message id (dedupe)
  created_at timestamptz not null default now()
);

create index if not exists wa_messages_conversation_idx on wa_messages (conversation_id, created_at);

alter table wa_conversations enable row level security;
alter table wa_messages enable row level security;

do $$
declare t text;
begin
  foreach t in array array['wa_conversations','wa_messages']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;
