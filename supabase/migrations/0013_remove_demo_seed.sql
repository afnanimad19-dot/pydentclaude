-- Pydental — migration 13: remove the bundled demo/sample seed so each clinic
-- starts clean. Your real data (captured WhatsApp leads, agents and templates you
-- created, etc.) uses random ids and is NOT touched — only the fixed-id seed rows
-- from migrations 0001/0002/0004 are removed. Run in Supabase → SQL Editor.

do $$
declare seed uuid[];
begin
  select array_agg(id) into seed from patients where id::text like '00000000-0000-0000-0000-%';
  if seed is not null then
    delete from payments where patient_id = any(seed);
    delete from documents where patient_id = any(seed);
    delete from insurance_policies where patient_id = any(seed);
    delete from treatment_procedures where plan_id in (select id from treatment_plans where patient_id = any(seed));
    delete from treatment_plans where patient_id = any(seed);
    delete from appointments where patient_id = any(seed);
    delete from patients where id = any(seed);
  end if;
end $$;

-- Seeded demo agents (Ava / Leo / etc. from 0002) and folders (0004).
delete from agents where id::text like '20000000-0000-0000-0000-%';
delete from patient_folders where id::text like '30000000-0000-0000-0000-%';

-- Seeded sample WhatsApp templates (0004). Templates you created stay.
delete from wa_templates where name in ('recall_cleaning_reminder', 'whitening_promo_june');
