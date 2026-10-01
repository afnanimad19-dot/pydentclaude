-- Pydent — migration 68: APPOINTMENT ↔ SERVICE IDENTITY (M1E-B — PROPOSED,
-- NOT YET APPLIED TO ANY ENVIRONMENT).
--
-- Gives appointments a stable, OPTIONAL reference into the service catalog
-- (migration 0067):
--
--   appointments.service_id ──▶ services(id)  [workspace-consistent]
--
-- Purely additive and deliberately empty: the column is nullable, nothing
-- backfills it, and it is never derived from the legacy free-text
-- appointments.procedure column (no name matching, no fuzzy matching —
-- legacy rows simply keep service_id NULL and their procedure text, and the
-- two fields stay independent until a caller-adoption milestone defines the
-- deliberate dual-write policy). No existing writer sets this column.
--
-- CROSS-WORKSPACE INTEGRITY (the M1B relational pattern): a plain FK to
-- services(id) would let a workspace A appointment reference workspace B's
-- service. Instead:
--  * 0067 is a pushed checkpoint, so its supporting constraint lives HERE:
--    services gains unique (id, workspace_id) — no new semantics (id is
--    already the PK), just a referenceable pair.
--  * appointments references THE PAIR: (service_id, workspace_id) →
--    services (id, workspace_id). Under MATCH SIMPLE, rows with
--    service_id NULL (every legacy row) are untouched, while any row that
--    sets service_id must name a service in ITS OWN workspace — enforced by
--    the database, not by application discipline.
--  * ON DELETE RESTRICT: a service referenced by any appointment cannot be
--    physically deleted — appointment identity is never silently erased.
--    Retirement is services.active = false (migration 0067's flag), not
--    deletion; a service no appointment references deletes normally. (No
--    PostgreSQL-version-specific syntax is used.)
--  * A guard CHECK closes the MATCH SIMPLE gap: appointments.workspace_id
--    is NULLABLE in the real schema (migration 0014 added it via
--    `add column if not exists workspace_id uuid references …` with no NOT
--    NULL, and no later migration tightens it — only backfills and a
--    default), so without the CHECK a row with a NULL workspace_id could
--    carry an unverified service_id. The CHECK is therefore REQUIRED, not
--    redundant.
--
-- Risk assessment: additive column + constraints, idempotent (guarded
-- do-blocks for the ALTERs that lack IF NOT EXISTS forms), no rewrite, no
-- backfill, no change to appointments.procedure/status/duration/external_id.
-- Rollback: drop the FK + check + column, then services' pair constraint.
-- Apply order: 0065 → 0066 → 0067 → 0068 (0068 structurally needs 0067).

-- 1) Referenceable (id, workspace_id) pair on services (0067 untouched).
do $$ begin
  alter table public.services
    add constraint services_id_ws_uq unique (id, workspace_id);
exception when duplicate_table then null; when duplicate_object then null; end $$;

-- 2) The nullable service reference on appointments.
alter table if exists public.appointments
  add column if not exists service_id uuid;

-- 3) Workspace-consistent composite FK; a referenced service cannot be
--    deleted (retire with services.active = false instead).
do $$ begin
  alter table public.appointments
    add constraint appointments_service_ws_fk
    foreign key (service_id, workspace_id)
    references public.services (id, workspace_id)
    on delete restrict;
exception when duplicate_object then null; end $$;

-- 4) MATCH SIMPLE guard: a service reference requires a workspace, so the
--    composite FK can never be skipped by a NULL workspace_id.
do $$ begin
  alter table public.appointments
    add constraint appointments_service_requires_ws_chk
    check (service_id is null or workspace_id is not null);
exception when duplicate_object then null; end $$;

-- 5) Workspace-scoped lookup index (reporting/adoption reads).
create index if not exists appointments_ws_service_idx
  on public.appointments (workspace_id, service_id);
