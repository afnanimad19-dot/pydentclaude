-- Pydental — migration 50: STRICT workspace RLS.
--
-- Until now every data table carried a wide-open "demo open access" policy
-- (`using (true) with check (true)`) so the anon key could read/write anything.
-- That means a logged-in user could, in principle, read another clinic's rows.
--
-- This migration replaces every such open policy with a workspace-scoped one:
--     using (workspace_id = current_workspace())
--     with check (workspace_id = current_workspace())
-- so each authenticated user only ever sees their own workspace's data.
--
-- SAFE TO SHIP because all server-to-server code paths (Twilio/WhatsApp/Vapi
-- webhooks, cron broadcast runners, Open Dental gateway, booking-server) now use
-- the SERVICE-ROLE client (src/lib/supabase-admin.ts), which BYPASSES RLS. Those
-- files already filter every query by workspace_id themselves, so their behaviour
-- is unchanged. Only the browser (anon key) is now constrained by RLS.
--
-- Idempotent: it only touches policies whose USING expression is literally `true`
-- (the demo-open policies) on tables that actually have a workspace_id column. It
-- leaves the own-scoped policies on `workspaces`/`profiles` and any table without
-- a workspace_id column (e.g. oauth_tokens) untouched. Re-running is a no-op.

-- Backfill child rows whose workspace_id was never set (e.g. inbound messages a
-- webhook stored before this fix) from their parent, so tightening RLS doesn't
-- hide existing inbox / broadcast history.
update wa_messages m
  set workspace_id = c.workspace_id
  from wa_conversations c
  where m.conversation_id = c.id and m.workspace_id is null and c.workspace_id is not null;

update wa_broadcast_recipients rcp
  set workspace_id = b.workspace_id
  from wa_broadcasts b
  where rcp.broadcast_id = b.id and rcp.workspace_id is null and b.workspace_id is not null;

update message_broadcast_recipients rcp
  set workspace_id = b.workspace_id
  from message_broadcasts b
  where rcp.broadcast_id = b.id and rcp.workspace_id is null and b.workspace_id is not null;

do $$
declare
  r record;
begin
  for r in
    select p.schemaname, p.tablename, p.policyname
    from pg_policies p
    where p.schemaname = 'public'
      -- only the wide-open demo policies (USING true)
      and p.qual = 'true'
      -- only tables that actually have a workspace_id column to scope by
      and exists (
        select 1 from information_schema.columns c
        where c.table_schema = p.schemaname
          and c.table_name = p.tablename
          and c.column_name = 'workspace_id'
      )
  loop
    -- Drop the open policy and replace it with a workspace-scoped one.
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    execute format(
      'create policy %I on public.%I for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace())',
      'workspace isolation', r.tablename
    );
    -- Make sure new inserts default to the caller's workspace so the WITH CHECK
    -- passes even when the client omits workspace_id.
    execute format('alter table public.%I alter column workspace_id set default current_workspace()', r.tablename);
  end loop;
end $$;
