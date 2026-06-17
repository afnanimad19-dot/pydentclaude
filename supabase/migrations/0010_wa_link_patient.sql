-- Pydental — migration 10: link live WhatsApp conversations to a patient/contact
-- so inbound leads are auto-captured into the CRM. Run in Supabase SQL Editor.

alter table wa_conversations
  add column if not exists patient_id uuid references patients(id) on delete set null;
