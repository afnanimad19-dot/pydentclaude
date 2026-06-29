-- Persist the clinic's display name (shown on the profile). Idempotent.

alter table if exists public.clinic_settings
  add column if not exists display_name text;
