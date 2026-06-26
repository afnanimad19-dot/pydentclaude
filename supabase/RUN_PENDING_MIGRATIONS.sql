-- ============================================================================
-- Pydent — run ALL pending migrations in one paste (0024 → 0034).
-- Safe to run multiple times (every statement is idempotent / create-if-not-exists).
-- Supabase → SQL Editor → New query → paste this whole file → Run.
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────
-- 0024_voices
-- ─────────────────────────────────────────────────────────────────────────
-- Pydental — migration 24: voice library + custom (cloned) voices.
-- A clinic can pick a premade voice OR record their own to clone it (managed TTS,
-- e.g. ElevenLabs). Custom voices are stored per-workspace here; premade voices
-- come live from the provider. The chosen voice id is saved on the agent.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

create table if not exists voices (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  voice_id text not null,                 -- provider (e.g. ElevenLabs) voice id
  name text not null default 'Custom voice',
  gender text default '',
  accent text default '',
  provider text not null default '11labs',
  created_at timestamptz not null default now()
);
create index if not exists voices_ws_idx on voices (workspace_id);
alter table voices enable row level security;
drop policy if exists "demo open access" on voices;
create policy "demo open access" on voices for all using (true) with check (true);

-- The provider voice id selected for a voice agent (premade or cloned).
alter table agents add column if not exists voice_id text;

-- ─────────────────────────────────────────────────────────────────────────
-- 0025_clinic_settings
-- ─────────────────────────────────────────────────────────────────────────
-- Pydent — migration 25: per-clinic settings (currently just the website URL).
-- Used so agents can pull knowledge straight from the clinic's own website.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

create table if not exists clinic_settings (
  workspace_id uuid primary key default current_workspace() references workspaces(id) on delete cascade,
  website text default '',
  updated_at timestamptz not null default now()
);
alter table clinic_settings enable row level security;
drop policy if exists "demo open access" on clinic_settings;
create policy "demo open access" on clinic_settings for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 0026_connections
-- ─────────────────────────────────────────────────────────────────────────
-- Pydent — migration 26: per-clinic integrations/connections.
-- Each clinic (workspace) connects ITS OWN Google/marketing accounts via OAuth.
-- The single OAuth *app* credentials live in env vars (the developer's app);
-- each clinic's tokens are stored here per workspace — never shared across clinics.
-- Idempotent, no ON CONFLICT. Run in a fresh SQL tab.

-- Connection status (safe to read in the dashboard): which providers a clinic has
-- connected and the account label. NO secrets here.
create table if not exists connections (
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  provider text not null,
  status text not null default 'connected',
  account_label text default '',
  connected_at timestamptz not null default now(),
  primary key (workspace_id, provider)
);
alter table connections enable row level security;
drop policy if exists "demo open access" on connections;
create policy "demo open access" on connections for all using (true) with check (true);

-- OAuth tokens (secrets) — per workspace + provider. NO RLS policy is created, so
-- the anon/public key cannot read it; only the server-side service-role key can.
create table if not exists oauth_tokens (
  workspace_id uuid not null,
  provider text not null,
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, provider)
);
alter table oauth_tokens enable row level security;

-- ─────────────────────────────────────────────────────────────────────────
-- 0027_sample_data_flag
-- ─────────────────────────────────────────────────────────────────────────
-- Pydent — migration 27: per-clinic "show sample data" flag.
-- Lets a real clinic hide the built-in demo/sample data so their dashboard shows
-- only their own records. Default true (keeps the sample data for new/demo accounts).
-- Idempotent. Run in a fresh SQL tab.

alter table clinic_settings add column if not exists show_sample_data boolean not null default true;

-- ─────────────────────────────────────────────────────────────────────────
-- 0028_connection_access_mode
-- ─────────────────────────────────────────────────────────────────────────
-- Pydent — migration 28: connection access mode (read-only vs read & write).
-- Lets each clinic choose what a connected integration is allowed to do.
-- Idempotent. Run in a fresh SQL tab.

alter table connections add column if not exists access_mode text not null default 'read';

-- ─────────────────────────────────────────────────────────────────────────
-- 0029_learning_questions
-- ─────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────
-- 0030_team_chats_brand
-- ─────────────────────────────────────────────────────────────────────────
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

-- ─────────────────────────────────────────────────────────────────────────
-- 0031_reports_activity
-- ─────────────────────────────────────────────────────────────────────────
-- Pydent — migration 31: downloadable reports + per-agent activity feed.
-- reports: a report an agent generated, served as DOCX/HTML on demand and shown
--   in the agent's Documents panel.
-- agent_activity: a log of what each agent did (published a blog, posted, pulled
--   a report, etc.) shown in the agent's Activity feed. Idempotent.

create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text default '',
  title text not null default 'Report',
  content_md text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists reports_ws_idx on reports (workspace_id, created_at desc);
alter table reports enable row level security;
drop policy if exists "demo open access" on reports;
create policy "demo open access" on reports for all using (true) with check (true);

create table if not exists agent_activity (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text not null,
  action text not null,
  detail text default '',
  link text default '',
  created_at timestamptz not null default now()
);
create index if not exists agent_activity_idx on agent_activity (workspace_id, agent_key, created_at desc);
alter table agent_activity enable row level security;
drop policy if exists "demo open access" on agent_activity;
create policy "demo open access" on agent_activity for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 0032_scheduled_tasks
-- ─────────────────────────────────────────────────────────────────────────
-- Pydent — migration 32: AI Team autopilot (scheduled recurring tasks).
-- e.g. "every Monday, write & draft a blog", "daily, draft an Instagram post".
-- A cron hits /api/cron/run which executes due tasks via the agent and reschedules.
-- Idempotent.

create table if not exists scheduled_tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  agent_key text not null,
  title text default '',
  instruction text not null,
  cadence text not null default 'weekly',     -- daily | weekly | monthly
  next_run timestamptz not null default now(),
  status text not null default 'active',       -- active | paused
  last_run timestamptz,
  last_result text default '',
  created_at timestamptz not null default now()
);
create index if not exists scheduled_tasks_due_idx on scheduled_tasks (status, next_run);
create index if not exists scheduled_tasks_ws_idx on scheduled_tasks (workspace_id, agent_key);
alter table scheduled_tasks enable row level security;
drop policy if exists "demo open access" on scheduled_tasks;
create policy "demo open access" on scheduled_tasks for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 0033_brand_documents
-- ─────────────────────────────────────────────────────────────────────────
-- Pydent — migration 33: brand knowledge documents.
-- Clinics upload as many brand docs as they want (any type); the extracted text
-- becomes part of every AI Team agent's brand knowledge. Idempotent.

create table if not exists brand_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  name text not null default 'Document',
  content text default '',
  created_at timestamptz not null default now()
);
create index if not exists brand_documents_ws_idx on brand_documents (workspace_id, created_at desc);
alter table brand_documents enable row level security;
drop policy if exists "demo open access" on brand_documents;
create policy "demo open access" on brand_documents for all using (true) with check (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 0034_voice_numbers
-- ─────────────────────────────────────────────────────────────────────────
-- Pydent — migration 34: voice phone numbers (Vapi / Twilio / SIP trunk).
-- Stores a connected number + how it's connected (config holds the SIP/Twilio
-- specifics). Replaces the simple phone_lines for the Voice → Phone Numbers page.
-- Idempotent.

create table if not exists voice_numbers (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  number text not null,
  nickname text default '',
  agent_id uuid,
  direction text not null default 'inbound',   -- inbound | outbound | both
  provider text not null default 'sip',         -- vapi | twilio | sip
  concurrency int not null default 1,
  config jsonb not null default '{}'::jsonb,     -- SIP/Twilio details
  created_at timestamptz not null default now()
);
create index if not exists voice_numbers_ws_idx on voice_numbers (workspace_id, created_at desc);
alter table voice_numbers enable row level security;
drop policy if exists "demo open access" on voice_numbers;
create policy "demo open access" on voice_numbers for all using (true) with check (true);
