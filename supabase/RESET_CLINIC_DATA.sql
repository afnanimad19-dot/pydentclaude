-- ============================================================================
-- RESET CLINIC DATA — start your account fresh (remove demo/seed rows)
-- ----------------------------------------------------------------------------
-- Run this in the Supabase dashboard → SQL Editor for the account you want to
-- clean. It deletes that ONE account's patients, appointments and conversations
-- so the dashboard shows only real data from now on. It is scoped by your login
-- email, so it will NOT touch any other clinic's data.
--
-- 1) Open Supabase → your project → SQL Editor → New query.
-- 2) Change the email below to YOUR login email.
-- 3) Run it. "Success. No rows returned" is normal.
--
-- ⚠️ This permanently deletes those rows. They're demo/old data, so that's the
--    point — but there's no undo. Run it once when you're ready to go live.
-- ============================================================================

-- Your login email (the account to clean):
--   change this line, keep the quotes:
-- =>  'afnanimad@gmail.com'

with me as (
  select p.workspace_id
  from profiles p
  join auth.users u on u.id = p.user_id
  where u.email = 'afnanimad@gmail.com'
)
-- children first (foreign keys), then parents:
, del_msgs as (
  delete from wa_messages
  where conversation_id in (select id from wa_conversations where workspace_id in (select workspace_id from me))
  returning 1
)
, del_convos as (
  delete from wa_conversations where workspace_id in (select workspace_id from me) returning 1
)
, del_appts as (
  delete from appointments where workspace_id in (select workspace_id from me) returning 1
)
, del_patients as (
  delete from patients where workspace_id in (select workspace_id from me) returning 1
)
select
  (select count(*) from del_msgs)    as deleted_messages,
  (select count(*) from del_convos)  as deleted_conversations,
  (select count(*) from del_appts)   as deleted_appointments,
  (select count(*) from del_patients) as deleted_patients;
