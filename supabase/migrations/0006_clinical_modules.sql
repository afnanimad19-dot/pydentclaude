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
