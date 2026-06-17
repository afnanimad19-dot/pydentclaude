-- Pydental — migration 11: real WhatsApp broadcasts (template send via Cloud API).
-- Run in Supabase Dashboard → SQL Editor.

-- Track the Meta template id once a template is submitted for approval.
alter table wa_templates add column if not exists meta_id text;

-- A broadcast campaign: an approved template sent to an audience (a patient folder).
create table if not exists wa_broadcasts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  folder_id uuid references patient_folders(id) on delete set null,
  folder_name text default '',
  template_name text not null,
  language text not null default 'en_US',
  status text not null default 'Draft' check (status in ('Draft','Scheduled','Sending','Sent','Failed')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  recipients int not null default 0,
  sent int not null default 0,
  delivered int not null default 0,
  read int not null default 0,
  failed int not null default 0,
  created_at timestamptz not null default now()
);

-- Per-recipient delivery tracking for a broadcast.
create table if not exists wa_broadcast_recipients (
  id uuid primary key default gen_random_uuid(),
  broadcast_id uuid not null references wa_broadcasts(id) on delete cascade,
  patient_id uuid references patients(id) on delete set null,
  phone text not null,
  name text default '',
  status text not null default 'queued' check (status in ('queued','sent','delivered','read','failed')),
  error text default '',
  wa_message_id text,
  created_at timestamptz not null default now()
);

create index if not exists wa_broadcast_recipients_idx on wa_broadcast_recipients (broadcast_id);

alter table wa_broadcasts enable row level security;
alter table wa_broadcast_recipients enable row level security;

do $$
declare t text;
begin
  foreach t in array array['wa_broadcasts','wa_broadcast_recipients']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;
