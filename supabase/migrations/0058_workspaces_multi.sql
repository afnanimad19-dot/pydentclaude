-- Pydent — migration 58: MULTIPLE WORKSPACES PER ACCOUNT.
--
-- Until now each account had exactly one workspace (profiles.workspace_id).
-- This adds a membership table so one account can OWN several workspaces and
-- switch between them, while keeping the strict isolation from migration 0050:
-- RLS still allows the browser to see ONLY the ACTIVE workspace
-- (workspace_id = current_workspace()), so no data — patients, WhatsApp
-- conversations, messages, stats, agents — ever bleeds between workspaces.
-- profiles.workspace_id simply becomes the "active workspace" pointer.
--
-- Idempotent: safe to re-run.

-- 1) Membership: which workspaces an account can use.
create table if not exists workspace_members (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'owner',
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
alter table workspace_members enable row level security;
drop policy if exists "own memberships" on workspace_members;
create policy "own memberships" on workspace_members
  for select using (user_id = auth.uid());

-- Backfill: every user's current workspace becomes a membership.
insert into workspace_members (workspace_id, user_id)
  select workspace_id, user_id from profiles
  on conflict do nothing;

-- 2) The workspaces list policy: a user can SEE every workspace they belong to
-- (needed for the switcher dropdown), while all DATA stays scoped to the active
-- one via current_workspace().
drop policy if exists "own workspace" on workspaces;
create policy "own workspace" on workspaces
  for select using (
    id in (select workspace_id from workspace_members where user_id = auth.uid())
    or id in (select workspace_id from profiles where user_id = auth.uid())
  );

-- 3) Create a new workspace and make it the active one. SECURITY DEFINER so the
-- insert bypasses the (intentionally missing) insert policy on workspaces —
-- creation is ONLY possible through this function, always self-owned.
create or replace function create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  insert into workspaces (name) values (coalesce(nullif(trim(p_name), ''), 'New clinic')) returning id into ws;
  insert into workspace_members (workspace_id, user_id) values (ws, auth.uid()) on conflict do nothing;
  update profiles set workspace_id = ws where user_id = auth.uid();
  return ws;
end $$;

-- 4) Switch the active workspace — ONLY to one the caller is a member of.
create or replace function switch_workspace(p_ws uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from workspace_members where workspace_id = p_ws and user_id = auth.uid()) then
    raise exception 'not a member of that workspace';
  end if;
  update profiles set workspace_id = p_ws where user_id = auth.uid();
end $$;

-- 5) New signups also get a membership row for their auto-created workspace.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  insert into workspaces (name) values (coalesce(new.email, 'My clinic')) returning id into ws;
  insert into profiles (user_id, workspace_id, email) values (new.id, ws, new.email);
  insert into workspace_members (workspace_id, user_id) values (ws, new.id) on conflict do nothing;
  return new;
end $$;
