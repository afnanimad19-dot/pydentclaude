-- Pydent — migration 29: learning agent.
-- Captures questions an agent couldn't answer (it deferred to the team) so the
-- clinic can teach the agent the answer. Summarized: repeated questions increment
-- `times_asked` instead of creating duplicates. Idempotent. Run in a fresh SQL tab.

create table if not exists learning_questions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_id uuid,
  agent_name text default '',
  question text not null,
  question_norm text not null,
  times_asked int not null default 1,
  status text not null default 'open',     -- open | taught
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists learning_questions_ws_idx on learning_questions (workspace_id, status);
alter table learning_questions enable row level security;
drop policy if exists "demo open access" on learning_questions;
create policy "demo open access" on learning_questions for all using (true) with check (true);
