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
