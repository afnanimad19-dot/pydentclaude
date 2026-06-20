-- Pydental — migration 23: team members. Invite staff by email with a role; when
-- they sign up with that email they JOIN the clinic's workspace (instead of getting
-- a new one). Conversations can be assigned to a teammate. No ON CONFLICT.
-- Run in a fresh SQL tab.

create table if not exists team_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  email text not null,
  name text default '',
  role text not null default 'editor' check (role in ('admin','editor','viewer')),
  status text not null default 'invited' check (status in ('invited','active')),
  created_at timestamptz not null default now()
);
create index if not exists team_members_ws_idx on team_members (workspace_id);
create index if not exists team_members_email_idx on team_members (lower(email));
alter table team_members enable row level security;
drop policy if exists "demo open access" on team_members;
create policy "demo open access" on team_members for all using (true) with check (true);

-- Who a conversation is assigned to (a person's name/email). Null = AI/unassigned.
alter table wa_conversations add column if not exists assigned_to text;

-- On signup: if invited to a clinic, join that workspace; else create a new one.
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare ws uuid;
begin
  select workspace_id into ws from team_members where lower(email) = lower(new.email) and status = 'invited' limit 1;
  if ws is not null then
    update team_members set status = 'active' where lower(email) = lower(new.email) and workspace_id = ws;
    insert into profiles (user_id, workspace_id, email) values (new.id, ws, new.email);
  else
    insert into workspaces (name) values (coalesce(new.email, 'My clinic')) returning id into ws;
    insert into profiles (user_id, workspace_id, email) values (new.id, ws, new.email);
  end if;
  return new;
end $$;
