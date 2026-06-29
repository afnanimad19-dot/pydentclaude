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
