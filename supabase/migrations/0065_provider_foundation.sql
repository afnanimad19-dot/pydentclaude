-- Pydent — migration 65: PROVIDER & OPERATORY FOUNDATION (M1A — PROPOSED, NOT
-- YET APPLIED TO ANY ENVIRONMENT).
--
-- First-class, PMS-independent provider/operatory entities, per-provider weekly
-- schedules, and time blocks (breaks / leave / blocked time / clinic-wide
-- closures). Purely additive: the legacy free-text appointments.provider and
-- appointments.operatory columns are untouched and remain operational; the new
-- appointments.provider_id / operatory_id columns are nullable and unused by
-- existing code until later milestones wire them in. No backfill of any kind —
-- especially no fuzzy doctor-name matching. External PMS identities (Open
-- Dental ProvNum/OpNum, D4W ids, …) deliberately have NO columns here; they
-- arrive with the generic external_mappings table in M1B.
--
-- Conventions:
--  * workspace_id: not null, default current_workspace(), cascade on workspace
--    delete — same shape as every tenant table since migration 0014.
--  * RLS: the strict workspace-isolation policy from migration 0050, created
--    directly (post-0050 tables never ship the old demo-open policy).
--  * weekday: lowercase English day name ('monday'…'sunday') — the exact
--    values weekdayInTz() / clinic_settings.closed_days already use in
--    src/lib/scheduling.ts, so no new representation is introduced.
--  * times: 'HH:MM' text, matching appointments.time and clinic_settings
--    open_time/close_time.
--  * Note: 0061_clinic_scheduling remains a separate, unapplied proposal;
--    clinic_settings stays the workspace-level scheduling default and provider
--    schedules are per-provider overrides on top of it.
--
-- Risk assessment:
--  * Additive only: new tables + two nullable FK columns on appointments
--    (`add column if not exists`, no default stamping, no rewrite, no data
--    loss). Idempotent — safe to re-run.
--  * appointments FKs use `on delete set null` so removing a provider or
--    operatory can never delete or orphan an appointment row.
--  * Rollback: drop the two appointments columns, then the four tables
--    (schedule_blocks, provider_schedules first — they FK providers).
--  * No RLS change to any existing table; no per-clinic values seeded.

-- --------------------------------------------------------------- providers
create table if not exists public.providers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace() references public.workspaces(id) on delete cascade,
  name text not null,
  display_name text default '',
  specialty text default '',
  color text default '',
  active boolean not null default true,
  booking_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists providers_ws_idx on public.providers (workspace_id);

alter table public.providers enable row level security;
drop policy if exists "workspace isolation" on public.providers;
create policy "workspace isolation" on public.providers
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());

-- ------------------------------------------------------- provider_schedules
-- A provider's recurring weekly working window(s). More than one row per
-- weekday is allowed (e.g. a morning and an evening shift). Providers without
-- rows simply inherit the clinic-wide hours — availability logic comes later.
create table if not exists public.provider_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace() references public.workspaces(id) on delete cascade,
  provider_id uuid not null references public.providers(id) on delete cascade,
  weekday text not null check (weekday in ('monday','tuesday','wednesday','thursday','friday','saturday','sunday')),
  start_time text not null default '09:00' check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time text not null default '17:00' check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists provider_schedules_ws_idx on public.provider_schedules (workspace_id);
create index if not exists provider_schedules_provider_idx on public.provider_schedules (provider_id, weekday);

alter table public.provider_schedules enable row level security;
drop policy if exists "workspace isolation" on public.provider_schedules;
create policy "workspace isolation" on public.provider_schedules
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());

-- ----------------------------------------------------------- schedule_blocks
-- One-off blocked time: a provider's break or leave, or (provider_id null) a
-- clinic-wide closure. Only stored here in M1A — nothing consumes it yet.
create table if not exists public.schedule_blocks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace() references public.workspaces(id) on delete cascade,
  provider_id uuid references public.providers(id) on delete cascade,  -- null = whole clinic
  date date not null,
  start_time text not null default '00:00' check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  end_time text not null default '23:59' check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  block_type text not null default 'blocked' check (block_type in ('break','leave','blocked','closure')),
  reason text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists schedule_blocks_ws_date_idx on public.schedule_blocks (workspace_id, date);
create index if not exists schedule_blocks_provider_idx on public.schedule_blocks (provider_id, date);

alter table public.schedule_blocks enable row level security;
drop policy if exists "workspace isolation" on public.schedule_blocks;
create policy "workspace isolation" on public.schedule_blocks
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());

-- --------------------------------------------------------------- operatories
create table if not exists public.operatories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace() references public.workspaces(id) on delete cascade,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists operatories_ws_idx on public.operatories (workspace_id);

alter table public.operatories enable row level security;
drop policy if exists "workspace isolation" on public.operatories;
create policy "workspace isolation" on public.operatories
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());

-- ------------------------------------------- appointments: additive columns
-- Nullable stable references alongside — never instead of — the legacy
-- free-text provider/operatory columns. No backfill; existing rows keep null.
alter table if exists public.appointments
  add column if not exists provider_id uuid references public.providers(id) on delete set null,
  add column if not exists operatory_id uuid references public.operatories(id) on delete set null;
create index if not exists appointments_provider_id_idx on public.appointments (provider_id);
create index if not exists appointments_operatory_id_idx on public.appointments (operatory_id);
