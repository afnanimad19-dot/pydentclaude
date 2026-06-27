-- Pydent — migration 36: richer booking metadata on appointments so a booking
-- (from a voice call OR a chat agent) records the fee the patient booked for and
-- exactly where it came from. Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

alter table appointments add column if not exists fee numeric;
-- Channel the booking came through: 'voice' | 'whatsapp' | 'instagram' |
-- 'messenger' | 'sms' | 'email' | 'manual'.
alter table appointments add column if not exists source text;
-- Which agent booked it (e.g. the voice agent's or chat agent's name).
alter table appointments add column if not exists booked_by text;
