-- Pydent — migration 38: richer voice-call records for the Callab-style Call Logs
-- list + detail page. Adds the called number, the end reason, the structured
-- conversation timeline (incl. tool calls), and post-call structured data.
-- Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

alter table voice_calls add column if not exists to_phone text default '';
alter table voice_calls add column if not exists ended_reason text default '';
-- Structured turn-by-turn timeline from Vapi (roles, text, timing, tool calls).
alter table voice_calls add column if not exists messages jsonb default '[]'::jsonb;
-- Post-call structured data extraction (Call Outcome) from the analysis plan.
alter table voice_calls add column if not exists structured_data jsonb default '{}'::jsonb;
