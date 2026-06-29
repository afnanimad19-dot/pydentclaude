-- Store the Vapi phone-number id on each voice number so we can re-route inbound
-- to a different agent (PATCH /phone-number/{id}) without deleting and recreating
-- it. Idempotent.

alter table if exists public.voice_numbers
  add column if not exists vapi_phone_number_id text;
