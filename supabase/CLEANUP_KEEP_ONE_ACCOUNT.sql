-- ═══════════════════════════════════════════════════════════════════════════
-- ONE-OFF CLEANUP: keep ONE account (and its workspace + data), delete every
-- other login and every other workspace's data.
--
-- WHY the old accounts showed the same data: accounts created BEFORE the
-- workspace-isolation fix had their profile pointed at the primary (oldest)
-- workspace, so they literally shared it. (An email invited in Settings →
-- Users also joins the same workspace by design.) New signups since the fix
-- always get their own empty workspace — this script just cleans up the
-- legacy accounts.
--
-- ⚠️ IRREVERSIBLE. Run the PREVIEW first, check the keeper email, then run
-- the cleanup block. Supabase Dashboard → SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── STEP 1 — PREVIEW: see every account and which workspace it points at ────
-- (run this SELECT alone first)
select u.email,
       u.created_at,
       p.workspace_id,
       w.name as workspace_name
from auth.users u
left join profiles p on p.user_id = u.id
left join workspaces w on w.id = p.workspace_id
order by u.created_at;

-- ── STEP 2 — CLEANUP: set keeper_email, then run this block ─────────────────
do $$
declare
  keeper_email text := 'afnanimad19@gmail.com';  -- ←← CHANGE to YOUR exact login email
  keeper_id uuid;
  keeper_ws uuid;
begin
  select id into keeper_id from auth.users where lower(email) = lower(keeper_email);
  if keeper_id is null then
    raise exception 'No account found with email "%" — fix keeper_email at the top and re-run.', keeper_email;
  end if;
  select workspace_id into keeper_ws from profiles where user_id = keeper_id;
  if keeper_ws is null then
    raise exception 'The keeper account has no workspace yet — log in to Pydent once with it, then re-run.';
  end if;

  -- 1) Delete every OTHER login. Their profiles cascade away — including any
  --    legacy profile that pointed at the keeper''s workspace (the "two accounts,
  --    same data" symptom disappears with it).
  delete from auth.users where id <> keeper_id;

  -- 2) Delete every workspace that now has no member. The FK cascade wipes ALL
  --    of that workspace''s data everywhere: patients, appointments, inbox
  --    conversations & messages, agents, voice calls, broadcasts, workflows,
  --    pipeline, billing, settings, …
  delete from workspaces w
  where w.id <> keeper_ws
    and not exists (select 1 from profiles p where p.workspace_id = w.id);

  -- 3) Tables WITHOUT a cascading workspace FK — clean strays by hand:
  delete from whatsapp_config where workspace <> keeper_ws::text;  -- keyed by a TEXT column
  delete from oauth_tokens    where workspace_id <> keeper_ws;     -- secrets table, no FK
  delete from message_broadcast_recipients
    where workspace_id is not null and workspace_id <> keeper_ws;

  -- 4) Remove team invites for any other email — otherwise, if one of those
  --    deleted emails signs up again, the invite would re-join it to the
  --    keeper workspace instead of giving it a fresh empty one.
  delete from team_members where lower(email) <> lower(keeper_email);

  raise notice 'Done — kept % (workspace %). All other accounts and their data are removed.', keeper_email, keeper_ws;
end $$;

-- ── STEP 3 — VERIFY: should now list ONLY the keeper account ────────────────
select u.email, p.workspace_id, w.name as workspace_name
from auth.users u
left join profiles p on p.user_id = u.id
left join workspaces w on w.id = p.workspace_id;
