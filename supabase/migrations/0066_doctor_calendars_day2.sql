-- Pydent — migration 66: Smart Scheduling Day 2 — doctor_calendars extensions
-- (PROPOSED — NOT YET APPLIED TO ANY ENVIRONMENT; apply in the Supabase SQL
-- editor after review, like migrations 0061/0065. Requires 0065 first.)
--
-- Two additive columns on doctor_calendars:
--
--  * timezone — optional per-doctor IANA timezone OVERRIDE (e.g. a remote
--    teleconsult doctor working their own local hours). NULL means the
--    clinic's timezone (clinic_settings.timezone), which stays the default
--    for every existing and ordinary mapping. Validated server-side
--    (src/lib/doctor-calendars-server.ts); an invalid stored value falls back
--    to the clinic timezone at read time rather than breaking availability.
--
--  * is_test — marks mappings that point at the dedicated Pydent DEVELOPMENT
--    calendar (test configuration only — never a Callab.AI or production
--    clinical calendar). Availability computed from a test mapping is
--    labelled as test data end-to-end (API responses and AI tool output), so
--    test availability is never presented as confirmed clinical availability.
--
-- The application reads these columns defensively: when this migration is not
-- applied, src/lib/availability-server.ts retries its query with the 0065
-- column set, so deployments without 0066 keep working unchanged.
--
-- Risk assessment:
--  * Purely additive: two nullable/defaulted columns, no data rewrite, no
--    change to existing rows' behavior (NULL timezone = clinic tz,
--    is_test false = today's semantics).
--  * RLS unchanged — the 0065 workspace-isolation policy already covers every
--    column of the table.
--  * Rollback: alter table doctor_calendars drop column if exists timezone;
--              alter table doctor_calendars drop column if exists is_test;
--  * Idempotent — safe to re-run.

alter table doctor_calendars add column if not exists timezone text;
alter table doctor_calendars add column if not exists is_test boolean not null default false;

comment on column doctor_calendars.timezone is 'Optional IANA timezone override for this doctor; NULL = clinic timezone.';
comment on column doctor_calendars.is_test is 'True for development/test calendar mappings — availability from them is labelled as test data, never as confirmed clinical availability.';
