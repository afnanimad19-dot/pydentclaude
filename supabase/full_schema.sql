-- ============================================================================
-- Pydent — FULL SCHEMA (all migrations 0001–0057 combined, in order)
-- Paste this whole file into the Supabase SQL Editor of a NEW project and Run.
-- It creates every table, index, policy and function. Safe to re-run.
-- This is SCHEMA ONLY — it does not include your existing rows/data.
-- ============================================================================


-- ============================================================================
-- 0001_init.sql
-- ============================================================================

-- Pydental — initial schema + sample clinic seed.
-- Run this once in Supabase Dashboard → SQL Editor → New query → Run.
--
-- NOTE: RLS policies below are permissive (anyone with the publishable key
-- can read/write). That is fine for this demo phase with sample data, but
-- before onboarding a real clinic we will add Supabase Auth and lock these
-- policies down per clinic.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- patients
create table if not exists patients (
  id uuid primary key default gen_random_uuid(),
  pat_num integer unique,
  name text not null,
  phone text default '',
  email text default '',
  birthdate date,
  balance numeric not null default 0,
  insurance text default 'Self-pay',
  last_visit date,
  next_appointment timestamptz,
  recall_due boolean not null default false,
  status text not null default 'New' check (status in ('Active','Inactive','New')),
  preferred_channel text not null default 'whatsapp',
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------ appointments
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  apt_num integer unique,
  patient_id uuid not null references patients(id) on delete cascade,
  provider text not null default '',
  operatory text not null default '',
  procedure text not null default '',
  date date not null,
  time text not null default '09:00',
  duration_min integer not null default 60,
  status text not null default 'Scheduled'
    check (status in ('Scheduled','Confirmed','Completed','Broken','Unconfirmed')),
  confirmed_via text,
  google_calendar_event_id text,
  created_at timestamptz not null default now()
);

-- --------------------------------------------------------- treatment plans
create table if not exists treatment_plans (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  name text not null,
  presented_on date,
  status text not null default 'Presented'
    check (status in ('Presented','Accepted','In progress','Completed')),
  created_at timestamptz not null default now()
);

create table if not exists treatment_procedures (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references treatment_plans(id) on delete cascade,
  code text not null,
  description text not null,
  tooth text default '',
  fee numeric not null default 0,
  status text not null default 'Planned' check (status in ('Planned','Accepted','Completed'))
);

-- --------------------------------------------------------------- documents
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  name text not null,
  category text not null default 'Other',
  size_label text default '',
  storage_path text,
  uploaded_at timestamptz not null default now()
);

-- ------------------------------------------------------ insurance policies
create table if not exists insurance_policies (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  carrier text not null default '—',
  plan text not null default 'Self-pay',
  member_id text default '—',
  group_number text default '—',
  annual_max numeric not null default 0,
  used_benefits numeric not null default 0,
  deductible numeric not null default 0,
  status text not null default 'Pending verification'
    check (status in ('Verified','Pending verification','Expired'))
);

-- ---------------------------------------------------------------- payments
create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  date date not null default current_date,
  amount numeric not null,
  method text not null default 'Card (Stripe)',
  description text default '',
  status text not null default 'Paid' check (status in ('Paid','Pending','Refunded'))
);

-- -------------------------------------------------------------------- RLS
alter table patients enable row level security;
alter table appointments enable row level security;
alter table treatment_plans enable row level security;
alter table treatment_procedures enable row level security;
alter table documents enable row level security;
alter table insurance_policies enable row level security;
alter table payments enable row level security;

do $$
declare t text;
begin
  foreach t in array array['patients','appointments','treatment_plans','treatment_procedures','documents','insurance_policies','payments']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;

-- ------------------------------------------------------------------- seed
insert into patients (id, pat_num, name, phone, email, birthdate, balance, insurance, last_visit, next_appointment, recall_due, status) values
  ('00000000-0000-0000-0000-000000000001', 1042, 'Maria Hernandez', '+1 (305) 555-0114', 'maria.h@gmail.com',     '1987-04-12', 0,      'Delta Dental PPO', '2026-05-28', '2026-06-12 09:00+00', false, 'Active'),
  ('00000000-0000-0000-0000-000000000002', 1187, 'James Carter',    '+1 (305) 555-0162', 'jcarter88@yahoo.com',   '1979-11-03', 240.50, 'Cigna Dental',     '2025-12-15', null,                  true,  'Active'),
  ('00000000-0000-0000-0000-000000000003', 1290, 'Aisha Williams',  '+1 (786) 555-0190', 'aisha.w@outlook.com',   '1994-02-21', 0,      'MetLife',          '2026-06-02', '2026-06-13 14:30+00', false, 'Active'),
  ('00000000-0000-0000-0000-000000000004', 1311, 'Robert Kim',      '+1 (305) 555-0177', 'rkim@gmail.com',        '1968-07-30', 1180,   'Self-pay',         '2026-04-10', '2026-06-18 11:00+00', false, 'Active'),
  ('00000000-0000-0000-0000-000000000005', 1402, 'Sofia Lopez',     '+1 (786) 555-0145', 'sofia.lopez@gmail.com', '2001-09-17', 0,      'Guardian',         '2025-11-20', null,                  true,  'Inactive'),
  ('00000000-0000-0000-0000-000000000006', 1455, 'Daniel Osei',     '+1 (305) 555-0133', 'd.osei@gmail.com',      '1990-01-08', 75,     'Aetna',            '2026-06-09', '2026-09-09 10:00+00', false, 'Active'),
  ('00000000-0000-0000-0000-000000000007', 1503, 'Emily Tran',      '+1 (786) 555-0108', 'emily.tran@icloud.com', '1998-06-25', 0,      'Delta Dental PPO', null,         '2026-06-12 16:00+00', false, 'New'),
  ('00000000-0000-0000-0000-000000000008', 1544, 'Luis Mendoza',    '+1 (305) 555-0121', 'lmendoza@hotmail.com',  '1975-03-14', 520,    'Humana',           '2026-02-02', null,                  true,  'Active')
on conflict do nothing;

insert into appointments (apt_num, patient_id, provider, operatory, procedure, date, time, duration_min, status, confirmed_via) values
  (5012, '00000000-0000-0000-0000-000000000001', 'Dr. Patel',       'Op 1', 'Prophylaxis + Exam',     '2026-06-12', '09:00', 60, 'Confirmed',   'whatsapp'),
  (5013, '00000000-0000-0000-0000-000000000007', 'Dr. Patel',       'Op 2', 'New Patient Exam + FMX', '2026-06-12', '16:00', 90, 'Confirmed',   'voice'),
  (5014, '00000000-0000-0000-0000-000000000003', 'Dr. Gomez',       'Op 3', 'Crown Seat #19',         '2026-06-13', '14:30', 60, 'Unconfirmed', null),
  (5015, '00000000-0000-0000-0000-000000000004', 'Dr. Gomez',       'Op 1', 'Implant Consult',        '2026-06-18', '11:00', 45, 'Scheduled',   null),
  (5016, '00000000-0000-0000-0000-000000000006', 'Hygiene — Kelly', 'Op 4', 'Perio Maintenance',      '2026-09-09', '10:00', 50, 'Scheduled',   'sms')
on conflict do nothing;

insert into treatment_plans (id, patient_id, name, presented_on, status) values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000004', 'Implant restoration — lower right', '2026-04-10', 'Presented'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000008', 'Crown + restorative',               '2026-02-02', 'Accepted'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'Crown seat',                        '2026-05-12', 'In progress')
on conflict do nothing;

insert into treatment_procedures (plan_id, code, description, tooth, fee, status) values
  ('10000000-0000-0000-0000-000000000001', 'D6010', 'Implant placement',              '#30', 2400, 'Planned'),
  ('10000000-0000-0000-0000-000000000001', 'D6058', 'Abutment supported crown',       '#30', 1500, 'Planned'),
  ('10000000-0000-0000-0000-000000000001', 'D7140', 'Extraction (completed)',         '#30', 300,  'Completed'),
  ('10000000-0000-0000-0000-000000000002', 'D2740', 'Porcelain crown',                '#14', 1280, 'Accepted'),
  ('10000000-0000-0000-0000-000000000002', 'D2392', 'Composite filling, 2 surfaces',  '#15', 370,  'Accepted'),
  ('10000000-0000-0000-0000-000000000003', 'D2740', 'Porcelain crown',                '#19', 1280, 'Accepted');

insert into documents (patient_id, name, category, size_label, uploaded_at) values
  ('00000000-0000-0000-0000-000000000004', 'Panoramic X-ray — Apr 2026', 'X-ray',          '4.2 MB', '2026-04-10'),
  ('00000000-0000-0000-0000-000000000004', 'Implant consult consent',    'Consent form',   '180 KB', '2026-04-10'),
  ('00000000-0000-0000-0000-000000000004', 'Site #30 — before',          'Photo (before)', '2.1 MB', '2026-04-10'),
  ('00000000-0000-0000-0000-000000000001', 'Bitewings — May 2026',       'X-ray',          '3.8 MB', '2026-05-28'),
  ('00000000-0000-0000-0000-000000000001', 'Delta Dental card',          'Insurance',      '640 KB', '2025-01-14'),
  ('00000000-0000-0000-0000-000000000003', 'Crown prep — before',        'Photo (before)', '1.9 MB', '2026-05-12'),
  ('00000000-0000-0000-0000-000000000003', 'Crown prep — after',         'Photo (after)',  '2.0 MB', '2026-05-12');

insert into insurance_policies (patient_id, carrier, plan, member_id, group_number, annual_max, used_benefits, deductible, status) values
  ('00000000-0000-0000-0000-000000000001', 'Delta Dental', 'PPO Premier',    'DD-88412-MH', 'GRP-2210', 2000, 740,  50, 'Verified'),
  ('00000000-0000-0000-0000-000000000003', 'MetLife',      'Dental PPO High','ML-55218-AW', 'GRP-9904', 1500, 1120, 75, 'Verified'),
  ('00000000-0000-0000-0000-000000000004', '—',            'Self-pay',       '—',           '—',        0,    0,    0,  'Verified'),
  ('00000000-0000-0000-0000-000000000008', 'Humana',       'Dental Value',   'HU-30141-LM', 'GRP-1167', 1000, 410,  50, 'Pending verification');

insert into payments (patient_id, date, amount, method, description, status) values
  ('00000000-0000-0000-0000-000000000001', '2026-05-28', 145,  'Insurance',     'Prophylaxis + exam — Delta Dental claim', 'Paid'),
  ('00000000-0000-0000-0000-000000000001', '2026-05-28', 35,   'Card (Stripe)', 'Patient portion — copay',                 'Paid'),
  ('00000000-0000-0000-0000-000000000004', '2026-04-10', 300,  'Card (Stripe)', 'Extraction #30',                          'Paid'),
  ('00000000-0000-0000-0000-000000000004', '2026-06-01', 1180, 'Financing',     'Implant deposit — 12-month plan',         'Pending'),
  ('00000000-0000-0000-0000-000000000003', '2026-05-12', 640,  'Card (Stripe)', 'Crown #19 — 50% at prep',                 'Paid'),
  ('00000000-0000-0000-0000-000000000008', '2026-02-02', 200,  'Cash',          'Partial payment on balance',              'Paid');


-- ============================================================================
-- 0002_agents.sql
-- ============================================================================

-- Pydental — migration 2: AI agents, conversation assignments, follow-ups.
-- Run in Supabase Dashboard → SQL Editor (same as 0001).

-- --------------------------------------------------------------- ai agents
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'chat' check (kind in ('chat','voice')),
  role text not null default 'Knowledge base'
    check (role in ('Receptionist','Sales','Knowledge base','Appointment setter','Follow-up')),
  status text not null default 'Draft' check (status in ('Live','Paused','Draft')),
  -- chat agents (OpenRouter)
  model text default 'openai/gpt-4o-mini',
  -- voice agents (Vapi)
  vapi_assistant_id text,
  voice text default 'Warm female · US English',
  first_message text default '',
  language text default 'English',
  -- shared brain
  instructions text default '',
  knowledge_base text default '',
  can_book boolean not null default true,
  can_reschedule boolean not null default true,
  can_cancel boolean not null default false,
  channels text[] default array['whatsapp'],
  created_at timestamptz not null default now()
);

-- Which agent is assigned to which conversation/patient thread
create table if not exists agent_assignments (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  conversation_key text not null,           -- e.g. mock conversation id or phone number
  patient_id uuid references patients(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (conversation_key)
);

-- Pipeline follow-up enrollments (daily outreach to unresponsive leads)
create table if not exists follow_ups (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  deal_key text not null,                   -- pipeline deal reference
  patient_name text default '',
  cadence text not null default 'daily',
  last_sent_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (deal_key)
);

-- OAuth tokens for clinic-level integrations (Google Calendar etc.)
create table if not exists integration_tokens (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique,            -- 'google_calendar'
  refresh_token text not null,
  access_token text,
  expires_at timestamptz,
  account_email text,
  created_at timestamptz not null default now()
);

alter table agents enable row level security;
alter table agent_assignments enable row level security;
alter table follow_ups enable row level security;
alter table integration_tokens enable row level security;

do $$
declare t text;
begin
  foreach t in array array['agents','agent_assignments','follow_ups']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;

-- Tokens stay server-side only: no anon policy at all (service role bypasses RLS).

-- ------------------------------------------------------------------- seed
insert into agents (id, name, kind, role, status, model, voice, language, first_message, instructions, knowledge_base, can_book, can_reschedule, can_cancel, channels) values
  ('20000000-0000-0000-0000-000000000001', 'Ava', 'voice', 'Receptionist', 'Live', null,
   'Warm female · US English', 'English + Spanish',
   'Thank you for calling Bright Smile Dental, this is Ava. How can I help you today?',
   'You are the friendly front-desk receptionist for Bright Smile Dental. Answer questions about hours, insurance and pricing. Always offer to book an appointment. If the caller is in pain, give safe general comfort advice (cold compress, over-the-counter pain relief as directed on the label) and prioritize an urgent slot. Never give medical diagnosis.',
   'Office hours: Mon–Fri 8am–6pm, Sat 9am–2pm. Address: 4210 Coral Way, Miami FL. Insurance accepted: Delta Dental PPO, Cigna, MetLife, Aetna, Humana, Guardian. New patient exam + X-rays: $89 promo. Cleanings from $120. Emergencies seen same-day when possible.',
   true, true, false, array['voice']),
  ('20000000-0000-0000-0000-000000000002', 'Leo', 'voice', 'Follow-up', 'Live', null,
   'Friendly male · US English', 'English',
   'Hi, this is Leo calling from Bright Smile Dental!',
   'You call patients who are overdue for hygiene or have unscheduled treatment. Be warm and brief. Offer two concrete time slots. If voicemail, leave a short friendly message with the office number.',
   'Recall promo: free fluoride treatment with any rebooked cleaning this month. Office number: (305) 555-0100.',
   true, true, false, array['voice']),
  ('20000000-0000-0000-0000-000000000003', 'Mila', 'chat', 'Appointment setter', 'Live', 'openai/gpt-4o-mini',
   null, 'English + Spanish', '',
   'You are Mila, the WhatsApp assistant for Bright Smile Dental. Greet by name when known. Answer from the knowledge base only; if unsure, offer to connect a human. Your main goal: book, reschedule or confirm appointments. Keep replies under 3 sentences, friendly with light emoji use.',
   'Office hours: Mon–Fri 8am–6pm, Sat 9am–2pm. Booking slots available next week: Mon–Fri 9:00, 10:00, 11:30, 14:00, 15:30, 16:30. Insurance accepted: Delta Dental PPO, Cigna, MetLife, Aetna, Humana, Guardian. Whitening promo: $199 this month.',
   true, true, true, array['whatsapp','sms']),
  ('20000000-0000-0000-0000-000000000004', 'Sam', 'chat', 'Sales', 'Draft', 'anthropic/claude-3.5-haiku',
   null, 'English', '',
   'You are Sam, a consultative sales assistant. You follow up on treatment plans that were presented but not accepted. Focus on value, financing options and answering objections. Never pressure; always offer a consult call.',
   'Financing: 12-month 0% via in-house plan on treatment over $1,000. Implant packages from $3,900. Veneers from $800/tooth.',
   false, false, false, array['whatsapp','email'])
on conflict do nothing;


-- ============================================================================
-- 0003_agent_hub.sql
-- ============================================================================

-- Pydental — migration 3: agent hub (channel defaults + phone lines) and
-- richer agent configuration. Run in Supabase Dashboard → SQL Editor.

-- New agent fields
alter table agents add column if not exists purpose text default 'both'
  check (purpose in ('inbound','outbound','both'));
alter table agents add column if not exists first_message_mode text default 'assistant_first'
  check (first_message_mode in ('assistant_first','user_first','assistant_first_generated'));
alter table agents add column if not exists kb_files text[] default array[]::text[];

-- Allow the simplified 4 agent types (old rows with 'Knowledge base' keep working)
alter table agents drop constraint if exists agents_role_check;
alter table agents add constraint agents_role_check
  check (role in ('Receptionist','Sales','Knowledge base','Appointment setter','Follow-up'));

-- Default agent per messaging channel (the "AI Agent Hub")
create table if not exists channel_defaults (
  id uuid primary key default gen_random_uuid(),
  channel text not null unique,             -- whatsapp | instagram | messenger | sms | email | tiktok
  agent_id uuid references agents(id) on delete set null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Phone lines for voice agents (inbound/outbound routing)
create table if not exists phone_lines (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  agent_id uuid references agents(id) on delete set null,
  direction text not null default 'both' check (direction in ('inbound','outbound','both')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table channel_defaults enable row level security;
alter table phone_lines enable row level security;

do $$
declare t text;
begin
  foreach t in array array['channel_defaults','phone_lines']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;


-- ============================================================================
-- 0004_folders_templates.sql
-- ============================================================================

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
on conflict do nothing;

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


-- ============================================================================
-- 0005_workflows.sql
-- ============================================================================

-- Pydental — migration 5: workflows (automation canvas).
-- Run in Supabase Dashboard → SQL Editor.

create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  channel text not null default 'whatsapp',
  status text not null default 'Draft' check (status in ('Live','Paused','Draft')),
  nodes jsonb not null default '[]'::jsonb,  -- [{id,type,title,detail}]
  triggered_today integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table workflows enable row level security;
drop policy if exists "demo open access" on workflows;
create policy "demo open access" on workflows for all using (true) with check (true);

-- Seed the three flows that previously lived in the chatbot builder
insert into workflows (id, name, channel, status, triggered_today, nodes) values
  ('40000000-0000-0000-0000-000000000001', 'Hygiene recall & rebooking', 'whatsapp', 'Live', 38, '[
    {"id":"n1","type":"trigger","title":"Trigger: recall due","detail":"Patient overdue for hygiene ≥ 30 days"},
    {"id":"n2","type":"message","title":"Send recall message","detail":"Template: “Hi {{first_name}}, you''re due for your cleaning…” with 3 slot buttons"},
    {"id":"n3","type":"condition","title":"Patient replied?","detail":"Wait 24h → if no reply, retry once; after 2nd silence, queue voice call"},
    {"id":"n4","type":"action","title":"Book appointment","detail":"Create appointment in the chosen slot"},
    {"id":"n5","type":"message","title":"Confirmation + reminder","detail":"Send instant confirmation, reminder at T-24h and T-2h"}
  ]'::jsonb),
  ('40000000-0000-0000-0000-000000000002', 'FAQ & office-hours autoresponder', 'whatsapp', 'Live', 17, '[
    {"id":"n1","type":"trigger","title":"Trigger: inbound message","detail":"Any WhatsApp message outside an active conversation"},
    {"id":"n2","type":"agent","title":"AI agent answers","detail":"Assigned chat agent replies from its knowledge base"},
    {"id":"n3","type":"handoff","title":"Human handoff","detail":"Unresolved after 2 turns → assign to Front Desk inbox with full context"}
  ]'::jsonb),
  ('40000000-0000-0000-0000-000000000003', 'No-show recovery', 'sms', 'Paused', 0, '[
    {"id":"n1","type":"trigger","title":"Trigger: appointment broken","detail":"Appointment status changes to Broken"},
    {"id":"n2","type":"message","title":"Empathetic rebook text","detail":"“We missed you today — want to grab a new time?” with booking link"},
    {"id":"n3","type":"condition","title":"Booked within 48h?","detail":"If not, add to Pipeline → Contacted and notify Front Desk"}
  ]'::jsonb)
on conflict do nothing;


-- ============================================================================
-- 0006_clinical_modules.sql
-- ============================================================================

-- Pydental — migration 6: clinical chart modules (tooth chart, ledger
-- adjustments, insurance claims, prescriptions) and pipeline stage agents.
-- Run in Supabase Dashboard → SQL Editor.

-- Odontogram: one row per marked tooth (universal numbering 1–32)
create table if not exists tooth_chart_marks (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  tooth int not null check (tooth between 1 and 32),
  condition text not null default 'healthy'
    check (condition in ('healthy','planned','completed','watch','missing')),
  updated_at timestamptz not null default now(),
  unique (patient_id, tooth)
);

-- Manual account adjustments (charges / credits) on the patient ledger
create table if not exists ledger_adjustments (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  date date not null default current_date,
  description text not null default '',
  amount numeric not null default 0,        -- positive = charge, negative = credit
  created_at timestamptz not null default now()
);

-- Insurance claims billed to a carrier
create table if not exists insurance_claims (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  carrier text not null,
  procedures text not null default '',      -- summary of CDT codes on the claim
  billed numeric not null default 0,
  est_insurance numeric not null default 0,
  status text not null default 'Draft'
    check (status in ('Draft','Sent','Received','Paid')),
  created_at timestamptz not null default now()
);

-- Prescriptions written on the patient chart
create table if not exists prescriptions (
  id uuid primary key default gen_random_uuid(),
  patient_id uuid not null references patients(id) on delete cascade,
  drug text not null,
  sig text not null default '',             -- directions for use
  quantity text default '',
  refills int not null default 0,
  status text not null default 'Active'
    check (status in ('Active','Sent to pharmacy','Completed')),
  date date not null default current_date,
  created_at timestamptz not null default now()
);

-- Which AI agent owns each pipeline stage (deals entering it are handed over)
create table if not exists pipeline_stage_agents (
  stage_id text primary key,
  agent_id uuid references agents(id) on delete set null,
  updated_at timestamptz not null default now()
);

alter table tooth_chart_marks enable row level security;
alter table ledger_adjustments enable row level security;
alter table insurance_claims enable row level security;
alter table prescriptions enable row level security;
alter table pipeline_stage_agents enable row level security;

do $$
declare t text;
begin
  foreach t in array array['tooth_chart_marks','ledger_adjustments','insurance_claims','prescriptions','pipeline_stage_agents']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;


-- ============================================================================
-- 0007_whatsapp_config.sql
-- ============================================================================

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


-- ============================================================================
-- 0008_wa_inbox.sql
-- ============================================================================

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


-- ============================================================================
-- 0009_wa_webhook_log.sql
-- ============================================================================

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


-- ============================================================================
-- 0010_wa_link_patient.sql
-- ============================================================================

-- Pydental — migration 10: link live WhatsApp conversations to a patient/contact
-- so inbound leads are auto-captured into the CRM. Run in Supabase SQL Editor.

alter table wa_conversations
  add column if not exists patient_id uuid references patients(id) on delete set null;


-- ============================================================================
-- 0011_wa_broadcasts.sql
-- ============================================================================

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


-- ============================================================================
-- 0012_meta_channels.sql
-- ============================================================================

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


-- ============================================================================
-- 0013_remove_demo_seed.sql
-- ============================================================================

-- Pydental — migration 13: remove the bundled demo/sample seed so each clinic
-- starts clean. Your real data (captured WhatsApp leads, agents and templates you
-- created, etc.) uses random ids and is NOT touched — only the fixed-id seed rows
-- from migrations 0001/0002/0004 are removed. Run in Supabase → SQL Editor.

do $$
declare seed uuid[];
begin
  select array_agg(id) into seed from patients where id::text like '00000000-0000-0000-0000-%';
  if seed is not null then
    delete from payments where patient_id = any(seed);
    delete from documents where patient_id = any(seed);
    delete from insurance_policies where patient_id = any(seed);
    delete from treatment_procedures where plan_id in (select id from treatment_plans where patient_id = any(seed));
    delete from treatment_plans where patient_id = any(seed);
    delete from appointments where patient_id = any(seed);
    delete from patients where id = any(seed);
  end if;
end $$;

-- Seeded demo agents (Ava / Leo / etc. from 0002) and folders (0004).
delete from agents where id::text like '20000000-0000-0000-0000-%';
delete from patient_folders where id::text like '30000000-0000-0000-0000-%';

-- Seeded sample WhatsApp templates (0004). Templates you created stay.
delete from wa_templates where name in ('recall_cleaning_reminder', 'whitening_promo_june');


-- ============================================================================
-- 0014_multi_tenant.sql
-- ============================================================================

-- Pydental — migration 14: multi-tenant. Each clinic gets its own workspace; all
-- data is scoped to a workspace. New signups get an empty workspace automatically;
-- existing data is assigned to the primary (oldest) account. Run in Supabase SQL Editor.

create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My clinic',
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);

alter table workspaces enable row level security;
alter table profiles enable row level security;
drop policy if exists "own workspace" on workspaces;
create policy "own workspace" on workspaces for select using (id in (select workspace_id from profiles where user_id = auth.uid()));
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- The caller's workspace (used as the default workspace_id on inserts).
create or replace function current_workspace() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where user_id = auth.uid()
$$;

-- Auto-create a workspace + profile for each new signup.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  insert into workspaces (name) values (coalesce(new.email, 'My clinic')) returning id into ws;
  insert into profiles (user_id, workspace_id, email) values (new.id, ws, new.email);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- Backfill: give every existing user a workspace + profile.
do $$
declare u record; ws uuid;
begin
  for u in select id, email, created_at from auth.users order by created_at loop
    if not exists (select 1 from profiles where user_id = u.id) then
      insert into workspaces (name) values (coalesce(u.email, 'My clinic')) returning id into ws;
      insert into profiles (user_id, workspace_id, email) values (u.id, ws, u.email);
    end if;
  end loop;
end $$;

-- Add workspace_id to every data table, backfill existing rows to the primary
-- (oldest) workspace, and default new rows to the caller's workspace.
do $$
declare t text; primary_ws uuid;
  tbls text[] := array[
    'patients','appointments','treatment_plans','treatment_procedures','documents',
    'insurance_policies','payments','agents','channel_defaults','phone_lines',
    'agent_assignments','follow_ups','patient_folders','wa_templates','ig_posts',
    'workflows','tooth_chart_marks','ledger_adjustments','insurance_claims',
    'prescriptions','pipeline_stage_agents','wa_conversations','wa_messages',
    'wa_broadcasts','wa_broadcast_recipients'
  ];
begin
  select p.workspace_id into primary_ws from profiles p join auth.users u on u.id = p.user_id order by u.created_at asc limit 1;
  foreach t in array tbls loop
    execute format('alter table %I add column if not exists workspace_id uuid references workspaces(id) on delete cascade', t);
    if primary_ws is not null then
      execute format('update %I set workspace_id = %L where workspace_id is null', t, primary_ws);
    end if;
    execute format('alter table %I alter column workspace_id set default current_workspace()', t);
  end loop;
end $$;

-- Replace global unique constraints with per-workspace ones (two clinics may both
-- have a "whatsapp" default, a folder named "VIP", the same contact, etc.).
alter table channel_defaults drop constraint if exists channel_defaults_channel_key;
create unique index if not exists channel_defaults_ws_channel on channel_defaults (workspace_id, channel);

alter table phone_lines drop constraint if exists phone_lines_number_key;
create unique index if not exists phone_lines_ws_number on phone_lines (workspace_id, number);

alter table patient_folders drop constraint if exists patient_folders_name_key;
create unique index if not exists patient_folders_ws_name on patient_folders (workspace_id, name);

alter table wa_conversations drop constraint if exists wa_conversations_contact_phone_key;
create unique index if not exists wa_conversations_ws_contact on wa_conversations (workspace_id, contact_phone, channel);

-- pipeline_stage_agents was keyed only by stage_id; key it per workspace.
alter table pipeline_stage_agents drop constraint if exists pipeline_stage_agents_pkey;
create unique index if not exists pipeline_stage_agents_ws_stage on pipeline_stage_agents (workspace_id, stage_id);

-- whatsapp_config is keyed by the text "workspace" column. Re-point the existing
-- single "default" row to the primary workspace id, and add the routing columns'
-- index so the webhook can find a clinic by its phone number.
do $$
declare primary_ws uuid;
begin
  select p.workspace_id into primary_ws from profiles p join auth.users u on u.id = p.user_id order by u.created_at asc limit 1;
  if primary_ws is not null then
    update whatsapp_config set workspace = primary_ws::text where workspace = 'default';
  end if;
end $$;
create index if not exists whatsapp_config_phone_idx on whatsapp_config (phone_number_id);
create index if not exists whatsapp_config_page_idx on whatsapp_config (page_id);


-- ============================================================================
-- 0015_opendental_config.sql
-- ============================================================================

-- Pydental — migration 15: Open Dental connection (per workspace). Stores ONLY
-- the clinic middleware URL + shared key — never any patient/clinical data.
-- Run in Supabase Dashboard → SQL Editor.

create table if not exists opendental_config (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  clinic_api_url text default '',     -- Cloudflare Tunnel URL of the clinic's local middleware
  clinic_api_key text default '',     -- shared secret for the middleware
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table opendental_config enable row level security;
drop policy if exists "demo open access" on opendental_config;
create policy "demo open access" on opendental_config for all using (true) with check (true);


-- ============================================================================
-- 0016_appointment_external_id.sql
-- ============================================================================

-- Pydental — migration 16: store the Open Dental appointment id on our calendar
-- appointments so the agent can reschedule/cancel the right one. Run in SQL Editor.

alter table appointments add column if not exists external_id text;


-- ============================================================================
-- 0017_agent_behavior.sql
-- ============================================================================

-- Pydental — migration 17: separate "behavior" guidance on agents (distinct from
-- instructions). Run in Supabase SQL Editor.

alter table agents add column if not exists behavior text default '';


-- ============================================================================
-- 0018_wa_message_dedupe.sql
-- ============================================================================

-- Pydental — migration 18: prevent duplicate inbound messages (Meta sometimes
-- retries the webhook, causing the agent to reply twice). Run in SQL Editor.

create unique index if not exists wa_messages_msgid_uniq
  on wa_messages (wa_message_id) where wa_message_id is not null;


-- ============================================================================
-- 0019_voice_calls.sql
-- ============================================================================

-- Pydental — migration 19: live voice calls (Vapi). Transcripts, recordings and
-- summaries land here from the Vapi webhook. Run in Supabase SQL Editor.

create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  vapi_call_id text,
  agent_id uuid references agents(id) on delete set null,
  agent_name text default '',
  caller_phone text default '',
  patient_id uuid references patients(id) on delete set null,
  direction text not null default 'inbound',
  status text not null default 'in-progress' check (status in ('in-progress','ended','failed')),
  started_at timestamptz default now(),
  ended_at timestamptz,
  duration_sec int not null default 0,
  transcript text default '',
  summary text default '',
  recording_url text default '',
  outcome text default '',
  created_at timestamptz not null default now()
);

create index if not exists voice_calls_ws_idx on voice_calls (workspace_id, created_at desc);
create index if not exists voice_calls_vapi_idx on voice_calls (vapi_call_id);

alter table voice_calls enable row level security;
drop policy if exists "demo open access" on voice_calls;
create policy "demo open access" on voice_calls for all using (true) with check (true);


-- ============================================================================
-- 0020_catchup.sql
-- ============================================================================

-- Pydental — migration 20: CATCH-UP. Safe to run once (idempotent). Contains
-- everything from 0015–0019 so you don't have to run those individually.
-- Requires 0014 (multi-tenant) to have been applied. Run in Supabase SQL Editor.

-- Make sure the helper exists (used as a column default).
create or replace function current_workspace() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where user_id = auth.uid()
$$;

-- 0015 — Open Dental connection (per workspace)
create table if not exists opendental_config (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  clinic_api_url text default '',
  clinic_api_key text default '',
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table opendental_config enable row level security;
drop policy if exists "demo open access" on opendental_config;
create policy "demo open access" on opendental_config for all using (true) with check (true);

-- 0016 — Open Dental appointment id on our calendar rows
alter table appointments add column if not exists external_id text;

-- 0017 — separate agent behavior box
alter table agents add column if not exists behavior text default '';

-- 0018 — dedupe inbound messages (stops the agent replying twice on Meta retries)
create unique index if not exists wa_messages_msgid_uniq
  on wa_messages (wa_message_id) where wa_message_id is not null;

-- 0019 — live voice calls (Vapi)
create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  vapi_call_id text,
  agent_id uuid references agents(id) on delete set null,
  agent_name text default '',
  caller_phone text default '',
  patient_id uuid references patients(id) on delete set null,
  direction text not null default 'inbound',
  status text not null default 'in-progress' check (status in ('in-progress','ended','failed')),
  started_at timestamptz default now(),
  ended_at timestamptz,
  duration_sec int not null default 0,
  transcript text default '',
  summary text default '',
  recording_url text default '',
  outcome text default '',
  created_at timestamptz not null default now()
);
create index if not exists voice_calls_ws_idx on voice_calls (workspace_id, created_at desc);
create index if not exists voice_calls_vapi_idx on voice_calls (vapi_call_id);
alter table voice_calls enable row level security;
drop policy if exists "demo open access" on voice_calls;
create policy "demo open access" on voice_calls for all using (true) with check (true);


-- ============================================================================
-- 0021_full_setup_idempotent.sql
-- ============================================================================

-- Pydental — migration 21: FULL idempotent setup. Run ONLY this file.
-- It is safe to run any number of times. It contains NO "on conflict" anywhere,
-- so it CANNOT produce error 42P10. It brings the database to the correct state
-- (multi-tenant foundation + every recent table/column). Missing tables are
-- skipped, so it won't fail if some earlier migration wasn't applied.

-- ── Multi-tenant foundation ────────────────────────────────────────────────
create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'My clinic',
  created_at timestamptz not null default now()
);
create table if not exists profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text,
  created_at timestamptz not null default now()
);
alter table workspaces enable row level security;
alter table profiles enable row level security;
drop policy if exists "own workspace" on workspaces;
create policy "own workspace" on workspaces for select using (id in (select workspace_id from profiles where user_id = auth.uid()));
drop policy if exists "own profile" on profiles;
create policy "own profile" on profiles for all using (user_id = auth.uid()) with check (user_id = auth.uid());

create or replace function current_workspace() returns uuid
language sql stable security definer set search_path = public as $$
  select workspace_id from profiles where user_id = auth.uid()
$$;

create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  insert into workspaces (name) values (coalesce(new.email, 'My clinic')) returning id into ws;
  insert into profiles (user_id, workspace_id, email) values (new.id, ws, new.email);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- Give every existing user a workspace.
do $$
declare u record; ws uuid;
begin
  for u in select id, email from auth.users order by created_at loop
    if not exists (select 1 from profiles where user_id = u.id) then
      insert into workspaces (name) values (coalesce(u.email, 'My clinic')) returning id into ws;
      insert into profiles (user_id, workspace_id, email) values (u.id, ws, u.email);
    end if;
  end loop;
end $$;

-- Add workspace_id to every data table that exists, backfill to the primary
-- (oldest) workspace, and default new rows to the caller's workspace.
do $$
declare t text; primary_ws uuid;
  tbls text[] := array[
    'patients','appointments','treatment_plans','treatment_procedures','documents',
    'insurance_policies','payments','agents','channel_defaults','phone_lines',
    'agent_assignments','follow_ups','patient_folders','wa_templates','ig_posts',
    'workflows','tooth_chart_marks','ledger_adjustments','insurance_claims',
    'prescriptions','pipeline_stage_agents','wa_conversations','wa_messages',
    'wa_broadcasts','wa_broadcast_recipients'
  ];
begin
  select p.workspace_id into primary_ws from profiles p join auth.users u on u.id = p.user_id order by u.created_at asc limit 1;
  foreach t in array tbls loop
    if exists (select 1 from information_schema.tables where table_schema='public' and table_name=t) then
      execute format('alter table %I add column if not exists workspace_id uuid references workspaces(id) on delete cascade', t);
      if primary_ws is not null then
        execute format('update %I set workspace_id = %L where workspace_id is null', t, primary_ws);
      end if;
      execute format('alter table %I alter column workspace_id set default current_workspace()', t);
    end if;
  end loop;
end $$;

-- ── Recent features (0015–0019) ────────────────────────────────────────────
create table if not exists opendental_config (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  clinic_api_url text default '',
  clinic_api_key text default '',
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table opendental_config enable row level security;
drop policy if exists "demo open access" on opendental_config;
create policy "demo open access" on opendental_config for all using (true) with check (true);

alter table appointments add column if not exists external_id text;
alter table agents add column if not exists behavior text default '';

-- Dedupe index for inbound messages (won't fail the script if duplicates exist).
do $$
begin
  create unique index if not exists wa_messages_msgid_uniq on wa_messages (wa_message_id) where wa_message_id is not null;
exception when others then null;
end $$;

create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  vapi_call_id text,
  agent_id uuid references agents(id) on delete set null,
  agent_name text default '',
  caller_phone text default '',
  patient_id uuid references patients(id) on delete set null,
  direction text not null default 'inbound',
  status text not null default 'in-progress',
  started_at timestamptz default now(),
  ended_at timestamptz,
  duration_sec int not null default 0,
  transcript text default '',
  summary text default '',
  recording_url text default '',
  outcome text default '',
  created_at timestamptz not null default now()
);
create index if not exists voice_calls_ws_idx on voice_calls (workspace_id, created_at desc);
create index if not exists voice_calls_vapi_idx on voice_calls (vapi_call_id);
alter table voice_calls enable row level security;
drop policy if exists "demo open access" on voice_calls;
create policy "demo open access" on voice_calls for all using (true) with check (true);


-- ============================================================================
-- 0022_add_missing_tables.sql
-- ============================================================================

-- Pydental — migration 22: adds ONLY the two tables that were missing
-- (opendental_config, voice_calls) plus the behavior column, external_id and the
-- message-dedupe index. No ON CONFLICT, no function dependency — cannot 42P10.
-- Run this in a fresh SQL tab. Do NOT run the old "Core Schema and Demo Seed" query.

create table if not exists opendental_config (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  clinic_api_url text default '',
  clinic_api_key text default '',
  enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table opendental_config enable row level security;
drop policy if exists "demo open access" on opendental_config;
create policy "demo open access" on opendental_config for all using (true) with check (true);

alter table agents add column if not exists behavior text default '';
alter table appointments add column if not exists external_id text;

do $$ begin
  create unique index if not exists wa_messages_msgid_uniq
    on wa_messages (wa_message_id) where wa_message_id is not null;
exception when others then null; end $$;

create table if not exists voice_calls (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  vapi_call_id text,
  agent_id uuid references agents(id) on delete set null,
  agent_name text default '',
  caller_phone text default '',
  patient_id uuid references patients(id) on delete set null,
  direction text not null default 'inbound',
  status text not null default 'in-progress',
  started_at timestamptz default now(),
  ended_at timestamptz,
  duration_sec int not null default 0,
  transcript text default '',
  summary text default '',
  recording_url text default '',
  outcome text default '',
  created_at timestamptz not null default now()
);
create index if not exists voice_calls_ws_idx on voice_calls (workspace_id, created_at desc);
create index if not exists voice_calls_vapi_idx on voice_calls (vapi_call_id);
alter table voice_calls enable row level security;
drop policy if exists "demo open access" on voice_calls;
create policy "demo open access" on voice_calls for all using (true) with check (true);


-- ============================================================================
-- 0023_team_members.sql
-- ============================================================================

-- Pydental — migration 23: team members. Invite staff by email with a role; when
-- they sign up with that email they JOIN the clinic's workspace (instead of getting
-- a new one). Conversations can be assigned to a teammate. No ON CONFLICT.
-- Run in a fresh SQL tab.

create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  email text not null,
  name text default '',
  role text not null default 'editor' check (role in ('admin','editor','viewer')),
  status text not null default 'invited' check (status in ('invited','active')),
  created_at timestamptz not null default now()
);
create index if not exists team_members_ws_idx on team_members (workspace_id);
create index if not exists team_members_email_idx on team_members (lower(email));
alter table team_members enable row level security;
drop policy if exists "demo open access" on team_members;
create policy "demo open access" on team_members for all using (true) with check (true);

-- Who a conversation is assigned to (a person's name/email). Null = AI/unassigned.
alter table wa_conversations add column if not exists assigned_to text;

-- On signup: if invited to a clinic, join that workspace; else create a new one.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  select workspace_id into ws from team_members where lower(email) = lower(new.email) and status = 'invited' limit 1;
  if ws is not null then
    update team_members set status = 'active' where lower(email) = lower(new.email) and workspace_id = ws;
    insert into profiles (user_id, workspace_id, email) values (new.id, ws, new.email);
  else
    insert into workspaces (name) values (coalesce(new.email, 'My clinic')) returning id into ws;
    insert into profiles (user_id, workspace_id, email) values (new.id, ws, new.email);
  end if;
  return new;
end $$;


-- ============================================================================
-- 0024_voices.sql
-- ============================================================================

-- Pydental — migration 24: voice library + custom (cloned) voices.
-- A clinic can pick a premade voice OR record their own to clone it (managed TTS,
-- e.g. ElevenLabs). Custom voices are stored per-workspace here; premade voices
-- come live from the provider. The chosen voice id is saved on the agent.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

create table if not exists voices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  voice_id text not null,                 -- provider (e.g. ElevenLabs) voice id
  name text not null default 'Custom voice',
  gender text default '',
  accent text default '',
  provider text not null default '11labs',
  created_at timestamptz not null default now()
);
create index if not exists voices_ws_idx on voices (workspace_id);
alter table voices enable row level security;
drop policy if exists "demo open access" on voices;
create policy "demo open access" on voices for all using (true) with check (true);

-- The provider voice id selected for a voice agent (premade or cloned).
alter table agents add column if not exists voice_id text;


-- ============================================================================
-- 0025_clinic_settings.sql
-- ============================================================================

-- Pydent — migration 25: per-clinic settings (currently just the website URL).
-- Used so agents can pull knowledge straight from the clinic's own website.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

create table if not exists clinic_settings (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  website text default '',
  updated_at timestamptz not null default now()
);
alter table clinic_settings enable row level security;
drop policy if exists "demo open access" on clinic_settings;
create policy "demo open access" on clinic_settings for all using (true) with check (true);


-- ============================================================================
-- 0026_connections.sql
-- ============================================================================

-- Pydent — migration 26: per-clinic integrations/connections.
-- Each clinic (workspace) connects ITS OWN Google/marketing accounts via OAuth.
-- The single OAuth *app* credentials live in env vars (the developer's app);
-- each clinic's tokens are stored here per workspace — never shared across clinics.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

-- Connection status (safe to read in the dashboard): which providers a clinic has
-- connected and the account label. NO secrets here.
create table if not exists connections (
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  provider text not null,
  status text not null default 'connected',
  account_label text default '',
  connected_at timestamptz not null default now(),
  primary key (workspace_id, provider)
);
alter table connections enable row level security;
drop policy if exists "demo open access" on connections;
create policy "demo open access" on connections for all using (true) with check (true);

-- OAuth tokens (secrets) — per workspace + provider. NO RLS policy is created, so
-- the anon/public key cannot read it; only the server-side service-role key can.
create table if not exists oauth_tokens (
  workspace_id uuid not null,
  provider text not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider)
);
alter table oauth_tokens enable row level security;


-- ============================================================================
-- 0027_sample_data_flag.sql
-- ============================================================================

-- Pydent — migration 27: per-clinic "show sample data" flag.
-- Lets a real clinic hide the built-in demo/sample data so their dashboard shows
-- only their own records. Default true (keeps the sample data for new/demo accounts).
-- Idempotent. Run in a fresh SQL tab.

alter table clinic_settings add column if not exists show_sample_data boolean not null default true;


-- ============================================================================
-- 0028_connection_access_mode.sql
-- ============================================================================

-- Pydent — migration 28: connection access mode (read-only vs read & write).
-- Lets each clinic choose what a connected integration is allowed to do.
-- Idempotent. Run in a fresh SQL tab.

alter table connections add column if not exists access_mode text not null default 'read';


-- ============================================================================
-- 0029_learning_questions.sql
-- ============================================================================

-- Pydent — migration 29: learning agent.
-- Captures questions an agent couldn't answer (it deferred to the team) so the
-- clinic can teach the agent the answer. Summarized: repeated questions increment
-- `times_asked` instead of creating duplicates. Idempotent. Run in a fresh SQL tab.

create table if not exists learning_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_id uuid,
  agent_name text default '',
  question text not null,
  question_norm text not null,
  times_asked int not null default 1,
  status text not null default 'open',     -- open | taught
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists learning_questions_ws_idx on learning_questions (workspace_id, status);
alter table learning_questions enable row level security;
drop policy if exists "demo open access" on learning_questions;
create policy "demo open access" on learning_questions for all using (true) with check (true);


-- ============================================================================
-- 0030_team_chats_brand.sql
-- ============================================================================

-- Pydent — migration 30: AI Team chat history + brand knowledge.
-- Saves each agent conversation (so you can start a new session and reopen past
-- ones) and a per-clinic brand profile the agents read so they know the clinic.
-- Idempotent. Run in a fresh SQL tab.

create table if not exists brand_knowledge (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  profile text default '',
  logo_url text default '',
  colors text default '',
  updated_at timestamptz not null default now()
);
alter table brand_knowledge enable row level security;
drop policy if exists "demo open access" on brand_knowledge;
create policy "demo open access" on brand_knowledge for all using (true) with check (true);

create table if not exists team_chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text not null,
  title text default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists team_chats_idx on team_chats (workspace_id, agent_key, updated_at desc);
alter table team_chats enable row level security;
drop policy if exists "demo open access" on team_chats;
create policy "demo open access" on team_chats for all using (true) with check (true);

create table if not exists team_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references team_chats(id) on delete cascade,
  role text not null,
  content text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists team_chat_messages_idx on team_chat_messages (chat_id, created_at);
alter table team_chat_messages enable row level security;
drop policy if exists "demo open access" on team_chat_messages;
create policy "demo open access" on team_chat_messages for all using (true) with check (true);


-- ============================================================================
-- 0031_reports_activity.sql
-- ============================================================================

-- Pydent — migration 31: downloadable reports + per-agent activity feed.
-- reports: a report an agent generated, served as DOCX/HTML on demand and shown
--   in the agent's Documents panel.
-- agent_activity: a log of what each agent did (published a blog, posted, pulled
--   a report, etc.) shown in the agent's Activity feed. Idempotent.

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text default '',
  title text not null default 'Report',
  content_md text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists reports_ws_idx on reports (workspace_id, created_at desc);
alter table reports enable row level security;
drop policy if exists "demo open access" on reports;
create policy "demo open access" on reports for all using (true) with check (true);

create table if not exists agent_activity (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text not null,
  action text not null,
  detail text default '',
  link text default '',
  created_at timestamptz not null default now()
);
create index if not exists agent_activity_idx on agent_activity (workspace_id, agent_key, created_at desc);
alter table agent_activity enable row level security;
drop policy if exists "demo open access" on agent_activity;
create policy "demo open access" on agent_activity for all using (true) with check (true);


-- ============================================================================
-- 0032_scheduled_tasks.sql
-- ============================================================================

-- Pydent — migration 32: AI Team autopilot (scheduled recurring tasks).
-- e.g. "every Monday, write & draft a blog", "daily, draft an Instagram post".
-- A cron hits /api/cron/run which executes due tasks via the agent and reschedules.
-- Idempotent.

create table if not exists scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text not null,
  title text default '',
  instruction text not null,
  cadence text not null default 'weekly',     -- daily | weekly | monthly
  next_run timestamptz not null default now(),
  status text not null default 'active',       -- active | paused
  last_run timestamptz,
  last_result text default '',
  created_at timestamptz not null default now()
);
create index if not exists scheduled_tasks_due_idx on scheduled_tasks (status, next_run);
create index if not exists scheduled_tasks_ws_idx on scheduled_tasks (workspace_id, agent_key);
alter table scheduled_tasks enable row level security;
drop policy if exists "demo open access" on scheduled_tasks;
create policy "demo open access" on scheduled_tasks for all using (true) with check (true);


-- ============================================================================
-- 0033_brand_documents.sql
-- ============================================================================

-- Pydent — migration 33: brand knowledge documents.
-- Clinics upload as many brand docs as they want (any type); the extracted text
-- becomes part of every AI Team agent's brand knowledge. Idempotent.

create table if not exists brand_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  name text not null default 'Document',
  content text default '',
  created_at timestamptz not null default now()
);
create index if not exists brand_documents_ws_idx on brand_documents (workspace_id, created_at desc);
alter table brand_documents enable row level security;
drop policy if exists "demo open access" on brand_documents;
create policy "demo open access" on brand_documents for all using (true) with check (true);


-- ============================================================================
-- 0034_voice_numbers.sql
-- ============================================================================

-- Pydent — migration 34: voice phone numbers (Vapi / Twilio / SIP trunk).
-- Stores a connected number + how it's connected (config holds the SIP/Twilio
-- specifics). Replaces the simple phone_lines for the Voice → Phone Numbers page.
-- Idempotent.

create table if not exists voice_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  number text not null,
  nickname text default '',
  agent_id uuid,
  direction text not null default 'inbound',   -- inbound | outbound | both
  provider text not null default 'sip',         -- vapi | twilio | sip
  concurrency int not null default 1,
  config jsonb not null default '{}'::jsonb,     -- SIP/Twilio details
  created_at timestamptz not null default now()
);
create index if not exists voice_numbers_ws_idx on voice_numbers (workspace_id, created_at desc);
alter table voice_numbers enable row level security;
drop policy if exists "demo open access" on voice_numbers;
create policy "demo open access" on voice_numbers for all using (true) with check (true);


-- ============================================================================
-- 0035_voice_settings.sql
-- ============================================================================

-- Pydent — migration 35: advanced voice-agent settings (Vapi/Callab-style).
-- Stores the whole advanced-settings object as one JSONB blob on the agent so
-- new knobs can be added without further schema changes. Run in Supabase SQL Editor.
-- Idempotent, no ON CONFLICT.

alter table agents add column if not exists voice_settings jsonb default '{}'::jsonb;


-- ============================================================================
-- 0036_appointment_booking_meta.sql
-- ============================================================================

-- Pydent — migration 36: richer booking metadata on appointments so a booking
-- (from a voice call OR a chat agent) records the fee the patient booked for and
-- exactly where it came from. Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

alter table appointments add column if not exists fee numeric;
-- Channel the booking came through: 'voice' | 'whatsapp' | 'instagram' |
-- 'messenger' | 'sms' | 'email' | 'manual'.
alter table appointments add column if not exists source text;
-- Which agent booked it (e.g. the voice agent's or chat agent's name).
alter table appointments add column if not exists booked_by text;


-- ============================================================================
-- 0037_agent_identity.sql
-- ============================================================================

-- Pydent — migration 37: Callab-style "Prompt Configuration" on agents. The prompt
-- is now three parts: Agent Identity (new), Tasks (= existing `instructions`),
-- Style Guardrails (= existing `behavior`). This adds the identity column.
-- Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

alter table agents add column if not exists agent_identity text default '';


-- ============================================================================
-- 0038_voice_call_detail.sql
-- ============================================================================

-- Pydent — migration 38: richer voice-call records for the Callab-style Call Logs
-- list + detail page. Adds the called number, the end reason, the structured
-- conversation timeline (incl. tool calls), and post-call structured data.
-- Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

alter table voice_calls add column if not exists to_phone text default '';
alter table voice_calls add column if not exists ended_reason text default '';
-- Structured turn-by-turn timeline from Vapi (roles, text, timing, tool calls).
alter table voice_calls add column if not exists messages jsonb default '[]'::jsonb;
-- Post-call structured data extraction (Call Outcome) from the analysis plan.
alter table voice_calls add column if not exists structured_data jsonb default '{}'::jsonb;


-- ============================================================================
-- 0039_campaigns.sql
-- ============================================================================

-- Pydent — migration 39: voice calling campaigns (the connective layer for the
-- Voice Agents tab — ties an agent + a phone number + a contact list together,
-- and lets Call Logs show/filter by campaign). Run in Supabase SQL Editor.
-- Idempotent, no ON CONFLICT.

create table if not exists campaigns (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  name text not null default '',
  agent_id uuid references agents(id) on delete set null,
  number_id uuid references voice_numbers(id) on delete set null,
  folder_id uuid,                 -- optional contact list (patient_folders.id)
  direction text not null default 'outbound',
  status text not null default 'active',
  created_at timestamptz not null default now()
);

-- Which campaign a logged call belongs to.
alter table voice_calls add column if not exists campaign_id uuid;

-- Demo-open RLS like the rest of the app (isolation is app-level via workspace_id).
alter table campaigns enable row level security;
do $$ begin
  create policy campaigns_all on campaigns for all using (true) with check (true);
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 0040_workflow_runs.sql
-- ============================================================================

-- Pydent — migration 40: workflow execution runs. The Workflows runner persists
-- one row per in-flight run so multi-step flows with waits survive across cron
-- ticks. Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

create table if not exists workflow_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  workflow_id uuid references workflows(id) on delete cascade,
  patient_id uuid,
  conversation_id uuid,
  channel text default 'whatsapp',
  contact_phone text default '',
  status text not null default 'running',   -- running | waiting | done | failed
  node_index int not null default 0,
  resume_at timestamptz,
  vars jsonb default '{}'::jsonb,
  log jsonb default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflow_runs_resume_idx on workflow_runs (status, resume_at);

alter table workflow_runs enable row level security;
do $$ begin
  create policy workflow_runs_all on workflow_runs for all using (true) with check (true);
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 0041_billing.sql
-- ============================================================================

-- Pydent — migration 41: per-workspace billing (minutes balance, plan, auto-recharge).
-- Card data is NEVER stored here — payment methods live in Stripe (PCI-compliant);
-- we only keep a Stripe customer id + the card's last4/brand for display.
-- Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

create table if not exists billing_settings (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  plan_name text default 'Starter',
  monthly_price numeric default 0,
  minutes_included integer default 0,
  minutes_balance numeric default 0,
  concurrency_limit integer default 5,
  next_billing date,
  auto_recharge boolean default false,
  recharge_below integer default 10,
  recharge_to integer default 60,
  price_per_minute numeric default 0.15,
  stripe_customer_id text,
  card_brand text,
  card_last4 text,
  card_exp text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Past invoices (populated by the Stripe webhook once billing is live).
create table if not exists billing_invoices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references workspaces(id) on delete cascade,
  description text default '',
  amount numeric default 0,
  status text default 'paid',
  invoice_url text,
  paid_at timestamptz default now()
);

alter table billing_settings enable row level security;
alter table billing_invoices enable row level security;
do $$ begin
  create policy billing_settings_all on billing_settings for all using (true) with check (true);
exception when duplicate_object then null; end $$;
do $$ begin
  create policy billing_invoices_all on billing_invoices for all using (true) with check (true);
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 0042_clinic_timezone.sql
-- ============================================================================

-- Pydent — migration 42: per-clinic timezone (used for Google Calendar push and
-- any scheduled times), so clinics in any region get correct local times — no
-- dependence on a server env var. Run in Supabase SQL Editor. Idempotent.

alter table clinic_settings add column if not exists timezone text default 'Asia/Dubai';


-- ============================================================================
-- 0043_voice_number_vapi_id.sql
-- ============================================================================

-- Store the Vapi phone-number id on each voice number so we can re-route inbound
-- to a different agent (PATCH /phone-number/{id}) without deleting and recreating
-- it. Idempotent.

alter table if exists public.voice_numbers
  add column if not exists vapi_phone_number_id text;


-- ============================================================================
-- 0044_oauth_meta_and_workflow_schedule.sql
-- ============================================================================

-- Durable Meta tokens: store the captured Page token + IG business id so posting
-- survives the short-lived user token. And give workflows a last_fired_at marker
-- for the scheduled "report" trigger. Both idempotent.

alter table if exists public.oauth_tokens
  add column if not exists meta jsonb;

alter table if exists public.workflows
  add column if not exists last_fired_at timestamptz;


-- ============================================================================
-- 0045_ig_publish.sql
-- ============================================================================

-- Instagram auto-publish: let the scheduler claim ('Publishing'), record success
-- ('Published' + media id) or failure ('Failed' + error), and store the public
-- image URL it used. Idempotent.

alter table if exists public.ig_posts drop constraint if exists ig_posts_status_check;
alter table if exists public.ig_posts
  add constraint ig_posts_status_check
  check (status in ('Draft', 'Scheduled', 'Publishing', 'Published', 'Failed'));

alter table if exists public.ig_posts
  add column if not exists ig_media_id text,
  add column if not exists image_url text,
  add column if not exists error text default '',
  add column if not exists published_at timestamptz;


-- ============================================================================
-- 0046_clinic_display_name.sql
-- ============================================================================

-- Persist the clinic's display name (shown on the profile). Idempotent.

alter table if exists public.clinic_settings
  add column if not exists display_name text;


-- ============================================================================
-- 0047_clinic_tags.sql
-- ============================================================================

-- Persist clinic tags (labels for contacts/conversations). Idempotent + demo-open RLS.

create table if not exists public.clinic_tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text not null,
  color text default '#7c3aed',
  created_at timestamptz default now()
);

alter table if exists public.clinic_tags enable row level security;

do $$ begin
  create policy clinic_tags_all on public.clinic_tags for all using (true) with check (true);
exception when duplicate_object then null;
end $$;


-- ============================================================================
-- 0048_message_broadcasts.sql
-- ============================================================================

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


-- ============================================================================
-- 0049_pipeline_deals.sql
-- ============================================================================

-- Persist manually-added pipeline deals (they used to be session-only and reset on
-- reload). Live WhatsApp leads already persist via wa_conversations.lifecycle; this
-- covers the cards a user adds by hand. Idempotent + demo-open RLS.

create table if not exists public.pipeline_deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references public.workspaces(id) on delete cascade,
  patient_name text not null default '',
  treatment text default '',
  value numeric default 0,
  source text default 'manual',
  owner text default '',
  stage_name text not null default 'New Lead',
  created_at timestamptz default now()
);

create index if not exists pipeline_deals_ws_idx on public.pipeline_deals (workspace_id);

alter table if exists public.pipeline_deals enable row level security;
do $$ begin
  create policy pipeline_deals_all on public.pipeline_deals for all using (true) with check (true);
exception when duplicate_object then null; end $$;


-- ============================================================================
-- 0050_workspace_rls.sql
-- ============================================================================

-- Pydental — migration 50: STRICT workspace RLS.
--
-- Until now every data table carried a wide-open "demo open access" policy
-- (`using (true) with check (true)`) so the anon key could read/write anything.
-- That means a logged-in user could, in principle, read another clinic's rows.
--
-- This migration replaces every such open policy with a workspace-scoped one:
--     using (workspace_id = current_workspace())
--     with check (workspace_id = current_workspace())
-- so each authenticated user only ever sees their own workspace's data.
--
-- SAFE TO SHIP because all server-to-server code paths (Twilio/WhatsApp/Vapi
-- webhooks, cron broadcast runners, Open Dental gateway, booking-server) now use
-- the SERVICE-ROLE client (src/lib/supabase-admin.ts), which BYPASSES RLS. Those
-- files already filter every query by workspace_id themselves, so their behaviour
-- is unchanged. Only the browser (anon key) is now constrained by RLS.
--
-- Idempotent: it only touches policies whose USING expression is literally `true`
-- (the demo-open policies) on tables that actually have a workspace_id column. It
-- leaves the own-scoped policies on `workspaces`/`profiles` and any table without
-- a workspace_id column (e.g. oauth_tokens) untouched. Re-running is a no-op.

-- Backfill child rows whose workspace_id was never set (e.g. inbound messages a
-- webhook stored before this fix) from their parent, so tightening RLS doesn't
-- hide existing inbox / broadcast history.
update wa_messages m
  set workspace_id = c.workspace_id
  from wa_conversations c
  where m.conversation_id = c.id and m.workspace_id is null and c.workspace_id is not null;

update wa_broadcast_recipients rcp
  set workspace_id = b.workspace_id
  from wa_broadcasts b
  where rcp.broadcast_id = b.id and rcp.workspace_id is null and b.workspace_id is not null;

update message_broadcast_recipients rcp
  set workspace_id = b.workspace_id
  from message_broadcasts b
  where rcp.broadcast_id = b.id and rcp.workspace_id is null and b.workspace_id is not null;

do $$
declare
  r record;
begin
  for r in
    select p.schemaname, p.tablename, p.policyname
    from pg_policies p
    where p.schemaname = 'public'
      -- only the wide-open demo policies (USING true)
      and p.qual = 'true'
      -- only tables that actually have a workspace_id column to scope by
      and exists (
        select 1 from information_schema.columns c
        where c.table_schema = p.schemaname
          and c.table_name = p.tablename
          and c.column_name = 'workspace_id'
      )
  loop
    -- Drop the open policy and replace it with a workspace-scoped one.
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    execute format(
      'create policy %I on public.%I for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace())',
      'workspace isolation', r.tablename
    );
    -- Make sure new inserts default to the caller's workspace so the WITH CHECK
    -- passes even when the client omits workspace_id.
    execute format('alter table public.%I alter column workspace_id set default current_workspace()', r.tablename);
  end loop;
end $$;


-- ============================================================================
-- 0051_opendental_credentials.sql
-- ============================================================================

-- Pydental — migration 51: Open Dental middleware username + password.
-- Some clinic middlewares sit behind HTTP Basic auth (a username + password)
-- in addition to the x-api-key shared secret. Store them per workspace so the
-- gateway can authenticate. Idempotent — safe to re-run.

alter table opendental_config add column if not exists clinic_username text default '';
alter table opendental_config add column if not exists clinic_password text default '';


-- ============================================================================
-- 0052_hyperfx_config.sql
-- ============================================================================

-- Pydental — migration 52: per-workspace Hyperfx.ai credentials.
-- Multi-clinic model: each clinic (workspace) can have its OWN Hyperfx
-- account/sub-account (enterprise plan), so its connected ad/SEO/calendar
-- platforms are isolated from every other clinic's. Falls back to the global
-- HYPERFX_MCP_URL / HYPERFX_API_KEY env vars when a workspace has no row.

create table if not exists hyperfx_config (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  mcp_url text default '',
  api_key text default '',
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

alter table hyperfx_config enable row level security;
drop policy if exists "workspace isolation" on hyperfx_config;
create policy "workspace isolation" on hyperfx_config
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());


-- ============================================================================
-- 0053_ads_autopilot.sql
-- ============================================================================

-- Pydental — migration 53: Meta ads recommendation autopilot.
-- Per-clinic toggle: when ON, the cron scans Meta's recommendations/errors on
-- the clinic's campaigns and sends creative-fatigue-type recommendations to
-- Helena, who generates a fresh creative and prepares a paused replacement ad.
-- autopilot_seen remembers which recommendations were already handled.

alter table hyperfx_config add column if not exists auto_recommendations boolean not null default false;
alter table hyperfx_config add column if not exists autopilot_seen jsonb not null default '[]'::jsonb;


-- ============================================================================
-- 0054_brand_identity.sql
-- ============================================================================

-- Brand Identity: richer, structured brand knowledge for a clinic — doctors,
-- services, contacts, socials, brand voice — stored as one JSON blob so new
-- fields can be added without further migrations. The human-readable summary is
-- still composed into brand_knowledge.profile (which the AI agents already read).
alter table if exists brand_knowledge
  add column if not exists details jsonb default '{}'::jsonb;


-- ============================================================================
-- 0055_content_calendar.sql
-- ============================================================================

-- Content Calendar (Later.com-style): the ig_posts table becomes multi-platform.
-- platforms = which networks to publish to (csv, e.g. 'instagram,facebook').
-- media_url = a public URL of the user's uploaded/chosen media (image/video).
-- (image_url already exists and holds the runner-resolved hosted image.)
alter table if exists ig_posts
  add column if not exists platforms text default 'instagram',
  add column if not exists media_url text default '';


-- ============================================================================
-- 0056_opendental_developer_key.sql
-- ============================================================================

-- Open Dental's own API authenticates with a Developer API Key + Customer API
-- Key via the header  Authorization: ODFHIR {DeveloperKey}/{CustomerKey}.
-- Store the developer key alongside the existing per-clinic customer key.
alter table if exists opendental_config
  add column if not exists developer_key text default '';


-- ============================================================================
-- 0057_agents_xai_id.sql
-- ============================================================================

-- Pydent voice agents are mirrored into the xAI console (Voice → Agents) via
-- the xAI Agents API, like the existing Vapi sync. Store the xAI agent id so
-- re-saves UPDATE the same console agent instead of creating duplicates.
alter table if exists agents
  add column if not exists xai_agent_id text default '';

