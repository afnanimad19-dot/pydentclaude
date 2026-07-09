-- Pydental — migration 51: Open Dental middleware username + password.
-- Some clinic middlewares sit behind HTTP Basic auth (a username + password)
-- in addition to the x-api-key shared secret. Store them per workspace so the
-- gateway can authenticate. Idempotent — safe to re-run.

alter table opendental_config add column if not exists clinic_username text default '';
alter table opendental_config add column if not exists clinic_password text default '';
