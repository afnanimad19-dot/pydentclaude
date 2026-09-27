-- Pydent — migration 63: LiveKit call recording metadata (Stage C2).
--
-- Recordings themselves live in a PRIVATE Azure Blob container; the database
-- stores only the object path and the egress lifecycle status. Playback goes
-- through an authenticated, workspace-checked route that mints a short-lived
-- blob-scoped read SAS — no public URLs are ever stored or exposed.
--
-- These columns are written only by the recording pipeline (session route +
-- LiveKit webhook egress events). No other automated writer names them, so —
-- as with the Stage B staff_outcome columns — nothing can overwrite them.
-- The Vapi `recording_url` column is untouched and keeps working as before.
--
-- No dependency on migrations 0061 or 0062: only voice_calls (0019) is needed.
-- Run in Supabase SQL Editor. Idempotent, additive only.

alter table voice_calls add column if not exists recording_path text not null default '';
alter table voice_calls add column if not exists recording_status text not null default '';
alter table voice_calls add column if not exists recording_egress_id text not null default '';

comment on column voice_calls.recording_path is 'Private storage object path (recordings/<workspace>/<room>.ogg). Never a public URL.';
comment on column voice_calls.recording_status is 'Recording lifecycle: empty = none, active, complete, failed: <reason>.';
comment on column voice_calls.recording_egress_id is 'LiveKit egress id for correlation and troubleshooting.';
