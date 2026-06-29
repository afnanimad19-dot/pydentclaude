-- Pydent — migration 42: per-clinic timezone (used for Google Calendar push and
-- any scheduled times), so clinics in any region get correct local times — no
-- dependence on a server env var. Run in Supabase SQL Editor. Idempotent.

alter table clinic_settings add column if not exists timezone text default 'Asia/Dubai';
