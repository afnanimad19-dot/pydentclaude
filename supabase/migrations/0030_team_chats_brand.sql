-- Pydent — migration 30: AI Team chat history + brand knowledge.
-- Saves each agent conversation (so you can start a new session and reopen past
-- ones) and a per-clinic brand profile the agents read so they know the clinic.
-- Idempotent. Run in a fresh SQL tab.

create table if not exists brand_knowledge (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  profile text default '',
  logo_url text default '',
  colors text default '',
  updated_at timestamptz not null default now()
);
alter table brand_knowledge enable row level security;
drop policy if exists "demo open access" on brand_knowledge;
create policy "demo open access" on brand_knowledge for all using (true) with check (true);

create table if not exists team_chats (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text not null,
  title text default 'New chat',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists team_chats_idx on team_chats (workspace_id, agent_key, updated_at desc);
alter table team_chats enable row level security;
drop policy if exists "demo open access" on team_chats;
create policy "demo open access" on team_chats for all using (true) with check (true);

create table if not exists team_chat_messages (
  id uuid primary key default gen_random_uuid(),
  chat_id uuid not null references team_chats(id) on delete cascade,
  role text not null,
  content text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists team_chat_messages_idx on team_chat_messages (chat_id, created_at);
alter table team_chat_messages enable row level security;
drop policy if exists "demo open access" on team_chat_messages;
create policy "demo open access" on team_chat_messages for all using (true) with check (true);
