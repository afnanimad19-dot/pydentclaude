-- Pydental — migration 4: patient folders, WhatsApp templates, Instagram posts.
-- Run in Supabase Dashboard → SQL Editor.

-- Folders to organize patients (used as broadcast audiences)
create table if not exists patient_folders (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);

alter table patients add column if not exists folder_id uuid references patient_folders(id) on delete set null;
alter table patients add column if not exists source_channel text;  -- whatsapp | sms | email | voice | manual
alter table patients add column if not exists source_agent text;    -- agent name that captured them

-- WhatsApp message templates (Meta approval lifecycle)
create table if not exists wa_templates (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null default 'MARKETING' check (category in ('MARKETING','UTILITY','AUTHENTICATION')),
  language text not null default 'English',
  header_type text default 'none' check (header_type in ('none','text','image','video','document')),
  header_text text default '',
  body text not null,
  footer text default '',
  buttons jsonb default '[]'::jsonb,   -- [{type:'url'|'phone'|'quick_reply', text, value}]
  status text not null default 'Draft' check (status in ('Draft','Pending approval','Approved','Rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Instagram scheduled posts (content calendar)
create table if not exists ig_posts (
  id uuid primary key default gen_random_uuid(),
  caption text not null default '',
  media_name text default '',
  scheduled_for date not null,
  time text default '10:00',
  status text not null default 'Scheduled' check (status in ('Draft','Scheduled','Published')),
  created_at timestamptz not null default now()
);

alter table patient_folders enable row level security;
alter table wa_templates enable row level security;
alter table ig_posts enable row level security;

do $$
declare t text;
begin
  foreach t in array array['patient_folders','wa_templates','ig_posts']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;

-- Starter folders + an approved sample template so broadcasting can be tried immediately
insert into patient_folders (id, name) values
  ('30000000-0000-0000-0000-000000000001', 'Came from WhatsApp'),
  ('30000000-0000-0000-0000-000000000002', 'Came from voice agent'),
  ('30000000-0000-0000-0000-000000000003', 'Recall overdue')
on conflict (name) do nothing;

insert into wa_templates (name, category, language, header_type, header_text, body, footer, buttons, status) values
  ('recall_cleaning_reminder', 'MARKETING', 'English', 'text', 'Time for your cleaning! 🦷',
   'Hi {{1}}, it''s been {{2}} months since your last visit at Bright Smile Dental. We have openings this week — want me to book you in?',
   'Send STOP to opt out',
   '[{"type":"quick_reply","text":"Book me in","value":""},{"type":"phone","text":"Call us","value":"+13055550100"}]'::jsonb,
   'Approved'),
  ('whitening_promo_june', 'MARKETING', 'English', 'image', '',
   'Hi {{1}}! ✨ This month only: professional whitening for $199 (reg. $350). Limited slots available.',
   'Send STOP to opt out',
   '[{"type":"url","text":"See details","value":"https://brightsmile.demo/whitening"},{"type":"quick_reply","text":"I''m interested","value":""}]'::jsonb,
   'Pending approval')
on conflict do nothing;
