-- Pydental — migration 3: agent hub (channel defaults + phone lines) and
-- richer agent configuration. Run in Supabase Dashboard → SQL Editor.

-- New agent fields
alter table agents add column if not exists purpose text default 'both'
  check (purpose in ('inbound','outbound','both'));
alter table agents add column if not exists first_message_mode text default 'assistant_first'
  check (first_message_mode in ('assistant_first','user_first','assistant_first_generated'));
alter table agents add column if not exists kb_files text[] default array[]::text[];

-- Allow the simplified 4 agent types (old rows with 'Knowledge base' keep working)
alter table agents drop constraint if exists agents_role_check;
alter table agents add constraint agents_role_check
  check (role in ('Receptionist','Sales','Knowledge base','Appointment setter','Follow-up'));

-- Default agent per messaging channel (the "AI Agent Hub")
create table if not exists channel_defaults (
  id uuid primary key default gen_random_uuid(),
  channel text not null unique,             -- whatsapp | instagram | messenger | sms | email | tiktok
  agent_id uuid references agents(id) on delete set null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- Phone lines for voice agents (inbound/outbound routing)
create table if not exists phone_lines (
  id uuid primary key default gen_random_uuid(),
  number text not null unique,
  agent_id uuid references agents(id) on delete set null,
  direction text not null default 'both' check (direction in ('inbound','outbound','both')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table channel_defaults enable row level security;
alter table phone_lines enable row level security;

do $$
declare t text;
begin
  foreach t in array array['channel_defaults','phone_lines']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;
