-- Pydent — migration 67: SERVICE / PROCEDURE FOUNDATION (M1E-A — PROPOSED,
-- NOT YET APPLIED TO ANY ENVIRONMENT).
--
-- First-class, PMS-neutral bookable-service catalog. The M1E-A audit
-- confirmed nothing canonical exists today: appointments.procedure is free
-- text, the booking modal and the clinic middleware carry hardcoded lists,
-- and treatment_plans/treatment_procedures are per-PATIENT clinical records
-- (plan-scoped, tooth-level, Planned/Accepted/Completed) — a clinical
-- ledger, not a catalog — so they are NOT reused here.
--
-- Identity rules:
--  * NO PMS columns, ever: no Open Dental or D4W ids, no PMS procedure- or
--    code-number columns.
--    A PMS's service/procedure identity lives ONLY in external_mappings
--    (migration 0066) as entity_type = 'service' with pydent_entity_id =
--    services.id — this is what eventually lets connector bookings resolve
--    an unambiguous external service id instead of free text (and lets the
--    clinic middleware's first-service fallback die).
--  * `code` is a PYDENT-INTERNAL optional label (e.g. a clinic's own
--    shorthand). It is NEVER an external PMS identity and must never be
--    sent to a PMS as one.
--  * default_duration_min is nullable and positive-only: unknown stays
--    NULL — no fabricated 30/60 default at the database layer. Legacy
--    booking keeps its existing clinic-level duration fallback unchanged.
--  * Pricing is deliberately ABSENT from this foundation: appointments.fee
--    is a per-booking quoted amount (varies by case, insurer, package and
--    agent-quoted KB pricing), so a single catalog price column would
--    invite divergence; a pricing model is a separate, later decision.
--
-- Dependencies / ordering: requires only workspaces + current_workspace()
-- (migration 0014) — NOT 0065. The external_mappings relationship is by
-- convention (entity_type = 'service'), not by FK, so 0067 does not
-- structurally require 0066 either; the natural apply order remains
-- 0065 → 0066 → 0067.
--
-- Risk assessment: purely additive single table, idempotent, no backfill,
-- no existing table touched. Rollback: drop table services.

create table if not exists public.services (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace() references public.workspaces(id) on delete cascade,
  name text not null,
  -- Optional text fields are NULLABLE with no default: NULL means "not
  -- provided" — never a fabricated empty string ('' and NULL must not both
  -- stand for the same missing value).
  display_name text,
  code text,                     -- Pydent-internal label ONLY — never an external PMS identity
  description text,
  default_duration_min integer check (default_duration_min is null or default_duration_min > 0),
  active boolean not null default true,
  booking_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists services_ws_idx on public.services (workspace_id);

alter table public.services enable row level security;
drop policy if exists "workspace isolation" on public.services;
create policy "workspace isolation" on public.services
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
