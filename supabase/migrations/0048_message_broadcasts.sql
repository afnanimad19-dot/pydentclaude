-- Native Email + SMS broadcasts to the clinic's OWN contact folders (like the
-- WhatsApp broadcast, but for email/SMS). Sends via the clinic's connected
-- Gmail/Brevo (email) or Twilio (SMS). Idempotent + demo-open RLS.

create table if not exists public.message_broadcasts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references public.workspaces(id) on delete cascade,
  name text not null default '',
  channel text not null default 'email' check (channel in ('email', 'sms')),
  folder_id uuid,
  folder_name text default '',
  subject text default '',
  body text default '',
  status text not null default 'Draft' check (status in ('Draft', 'Scheduled', 'Sending', 'Sent', 'Failed')),
  scheduled_for timestamptz,
  recipients int default 0,
  sent int default 0,
  failed int default 0,
  sent_at timestamptz,
  created_at timestamptz default now()
);

create table if not exists public.message_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid references public.message_broadcasts(id) on delete cascade,
  workspace_id uuid default current_workspace(),
  patient_id uuid,
  contact text default '',
  name text default '',
  status text default 'sent',
  error text default '',
  created_at timestamptz default now()
);

create index if not exists message_broadcasts_ws_idx on public.message_broadcasts (workspace_id, created_at desc);
create index if not exists message_broadcast_recipients_bid_idx on public.message_broadcast_recipients (broadcast_id);

alter table if exists public.message_broadcasts enable row level security;
alter table if exists public.message_broadcast_recipients enable row level security;

do $$ begin
  create policy message_broadcasts_all on public.message_broadcasts for all using (true) with check (true);
exception when duplicate_object then null; end $$;

do $$ begin
  create policy message_broadcast_recipients_all on public.message_broadcast_recipients for all using (true) with check (true);
exception when duplicate_object then null; end $$;
