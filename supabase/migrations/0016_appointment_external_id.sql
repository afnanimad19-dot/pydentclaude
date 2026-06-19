-- Pydental — migration 16: store the Open Dental appointment id on our calendar
-- appointments so the agent can reschedule/cancel the right one. Run in SQL Editor.

alter table appointments add column if not exists external_id text;
