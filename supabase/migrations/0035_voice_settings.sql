-- Pydent — migration 35: advanced voice-agent settings (Vapi/Callab-style).
-- Stores the whole advanced-settings object as one JSONB blob on the agent so
-- new knobs can be added without further schema changes. Run in Supabase SQL Editor.
-- Idempotent, no ON CONFLICT.

alter table agents add column if not exists voice_settings jsonb default '{}'::jsonb;
