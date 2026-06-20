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
