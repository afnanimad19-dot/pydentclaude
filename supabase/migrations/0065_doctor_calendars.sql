-- Pydent — migration 65: Smart Scheduling doctor → external calendar mappings
-- (PROPOSED — NOT YET APPLIED TO ANY ENVIRONMENT; apply in the Supabase SQL
-- editor after review, like migrations 0061+).
--
-- One row per (workspace, doctor, provider): which external calendar carries a
-- doctor's busy times. Day 1 uses provider 'google' with the Google Calendar
-- FreeBusy API (read-only). Calendar IDs are tenant-scoped DATA, not code —
-- nothing clinic-specific is hardcoded in the application.
--
-- The application reads this table defensively (src/lib/availability-server.ts
-- returns a clear `no_mapping` status when the table or a row is missing), so
-- deployments without this migration keep working unchanged.
--
-- Risk assessment:
--  * Purely additive: one new table, no change to existing tables or policies.
--  * RLS matches the repo convention: workspace_id = current_workspace(),
--    with the server (service-role client) filtering by workspace_id itself.
--  * No secrets stored: a calendar id is an address, not a credential; the
--    Google service-account key stays in the environment (never in the DB).
--  * Rollback: `drop table if exists doctor_calendars;`
--  * Idempotent — safe to re-run.

create table if not exists doctor_calendars (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  doctor_name text not null,               -- display name, matched like appointments.provider
  calendar_id text not null,               -- e.g. ...@group.calendar.google.com
  provider text not null default 'google', -- adapter seam for later PMS/calendar sources
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, provider, doctor_name)
);

create index if not exists doctor_calendars_ws_idx on doctor_calendars (workspace_id, active);

alter table doctor_calendars enable row level security;
drop policy if exists "workspace isolation" on doctor_calendars;
create policy "workspace isolation" on doctor_calendars
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
alter table doctor_calendars alter column workspace_id set default current_workspace();
