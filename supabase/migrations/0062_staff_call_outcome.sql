-- Pydent — migration 62: staff-confirmed call outcome (Stage B).
--
-- Clinic staff classify each call on the Call Details page:
--   Potential / Non-Potential / Closed / Cold Lead / Others (+ optional note).
--
-- These are NEW columns, deliberately separate from the engine-written
-- `outcome` column (Vapi's successEvaluation lands there) and from
-- `structured_data` (AI extraction / worker tool data): the webhook, call-log
-- and post-call writers never name these columns, so automated processing can
-- never overwrite what a staff member selected. The only writer is the
-- authenticated /api/voice/outcome route, which also validates the value —
-- allowed values are enforced server-side to keep this migration purely
-- additive and re-runnable.
--
-- Run in Supabase SQL Editor. Idempotent, additive only.

alter table voice_calls add column if not exists staff_outcome text not null default '';
alter table voice_calls add column if not exists staff_outcome_note text not null default '';
alter table voice_calls add column if not exists staff_outcome_by text not null default '';
alter table voice_calls add column if not exists staff_outcome_at timestamptz;

comment on column voice_calls.staff_outcome is 'Staff classification: potential | non_potential | closed | cold_lead | others (empty = not classified). Written only by /api/voice/outcome.';
comment on column voice_calls.staff_outcome_note is 'Optional staff note attached to the classification.';
comment on column voice_calls.staff_outcome_by is 'Email (or user id) of the staff member who last set the classification.';
comment on column voice_calls.staff_outcome_at is 'When the classification was last modified.';
