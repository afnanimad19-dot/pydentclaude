-- Pydent — migration 61: per-clinic scheduling settings (PROPOSED — NOT YET
-- APPLIED TO ANY ENVIRONMENT).
--
-- Adds opt-in clinic hours / slot grid / default appointment duration /
-- closed days to clinic_settings. The application already reads these columns
-- defensively (src/lib/scheduling.ts + booking-server.clinicScheduling):
-- when the columns are absent, or a workspace leaves them at their defaults,
-- availability behaves exactly as it always has (09:00–17:00, 30-minute grid,
-- 30-minute default duration, no closed days) — so applying this migration
-- changes nothing until a clinic edits the values.
--
-- Risk assessment:
--  * Additive `add column if not exists` with defaults — no table rewrite
--    beyond default stamping, no data loss, idempotent, safe to re-run.
--  * No RLS change (clinic_settings policies untouched).
--  * Rollback: drop the five columns.
--  * No per-clinic values are seeded here — clinics configure their own hours
--    in Settings; nothing LHDM-specific is hardcoded anywhere.

alter table if exists public.clinic_settings
  add column if not exists open_time text default '09:00',
  add column if not exists close_time text default '17:00',
  add column if not exists slot_minutes integer default 30,
  add column if not exists default_duration_min integer default 30,
  add column if not exists closed_days text default '';
