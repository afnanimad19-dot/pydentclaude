-- Pydental — migration 2: AI agents, conversation assignments, follow-ups.
-- Run in Supabase Dashboard → SQL Editor (same as 0001).

-- --------------------------------------------------------------- ai agents
create table if not exists agents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'chat' check (kind in ('chat','voice')),
  role text not null default 'Knowledge base'
    check (role in ('Receptionist','Sales','Knowledge base','Appointment setter','Follow-up')),
  status text not null default 'Draft' check (status in ('Live','Paused','Draft')),
  -- chat agents (OpenRouter)
  model text default 'openai/gpt-4o-mini',
  -- voice agents (Vapi)
  vapi_assistant_id text,
  voice text default 'Warm female · US English',
  first_message text default '',
  language text default 'English',
  -- shared brain
  instructions text default '',
  knowledge_base text default '',
  can_book boolean not null default true,
  can_reschedule boolean not null default true,
  can_cancel boolean not null default false,
  channels text[] default array['whatsapp'],
  created_at timestamptz not null default now()
);

-- Which agent is assigned to which conversation/patient thread
create table if not exists agent_assignments (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  conversation_key text not null,           -- e.g. mock conversation id or phone number
  patient_id uuid references patients(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (conversation_key)
);

-- Pipeline follow-up enrollments (daily outreach to unresponsive leads)
create table if not exists follow_ups (
  id uuid primary key default gen_random_uuid(),
  agent_id uuid not null references agents(id) on delete cascade,
  deal_key text not null,                   -- pipeline deal reference
  patient_name text default '',
  cadence text not null default 'daily',
  last_sent_at timestamptz,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (deal_key)
);

-- OAuth tokens for clinic-level integrations (Google Calendar etc.)
create table if not exists integration_tokens (
  id uuid primary key default gen_random_uuid(),
  provider text not null unique,            -- 'google_calendar'
  refresh_token text not null,
  access_token text,
  expires_at timestamptz,
  account_email text,
  created_at timestamptz not null default now()
);

alter table agents enable row level security;
alter table agent_assignments enable row level security;
alter table follow_ups enable row level security;
alter table integration_tokens enable row level security;

do $$
declare t text;
begin
  foreach t in array array['agents','agent_assignments','follow_ups']
  loop
    execute format('drop policy if exists "demo open access" on %I', t);
    execute format('create policy "demo open access" on %I for all using (true) with check (true)', t);
  end loop;
end $$;

-- Tokens stay server-side only: no anon policy at all (service role bypasses RLS).

-- ------------------------------------------------------------------- seed
insert into agents (id, name, kind, role, status, model, voice, language, first_message, instructions, knowledge_base, can_book, can_reschedule, can_cancel, channels) values
  ('20000000-0000-0000-0000-000000000001', 'Ava', 'voice', 'Receptionist', 'Live', null,
   'Warm female · US English', 'English + Spanish',
   'Thank you for calling Bright Smile Dental, this is Ava. How can I help you today?',
   'You are the friendly front-desk receptionist for Bright Smile Dental. Answer questions about hours, insurance and pricing. Always offer to book an appointment. If the caller is in pain, give safe general comfort advice (cold compress, over-the-counter pain relief as directed on the label) and prioritize an urgent slot. Never give medical diagnosis.',
   'Office hours: Mon–Fri 8am–6pm, Sat 9am–2pm. Address: 4210 Coral Way, Miami FL. Insurance accepted: Delta Dental PPO, Cigna, MetLife, Aetna, Humana, Guardian. New patient exam + X-rays: $89 promo. Cleanings from $120. Emergencies seen same-day when possible.',
   true, true, false, array['voice']),
  ('20000000-0000-0000-0000-000000000002', 'Leo', 'voice', 'Follow-up', 'Live', null,
   'Friendly male · US English', 'English',
   'Hi, this is Leo calling from Bright Smile Dental!',
   'You call patients who are overdue for hygiene or have unscheduled treatment. Be warm and brief. Offer two concrete time slots. If voicemail, leave a short friendly message with the office number.',
   'Recall promo: free fluoride treatment with any rebooked cleaning this month. Office number: (305) 555-0100.',
   true, true, false, array['voice']),
  ('20000000-0000-0000-0000-000000000003', 'Mila', 'chat', 'Appointment setter', 'Live', 'openai/gpt-4o-mini',
   null, 'English + Spanish', '',
   'You are Mila, the WhatsApp assistant for Bright Smile Dental. Greet by name when known. Answer from the knowledge base only; if unsure, offer to connect a human. Your main goal: book, reschedule or confirm appointments. Keep replies under 3 sentences, friendly with light emoji use.',
   'Office hours: Mon–Fri 8am–6pm, Sat 9am–2pm. Booking slots available next week: Mon–Fri 9:00, 10:00, 11:30, 14:00, 15:30, 16:30. Insurance accepted: Delta Dental PPO, Cigna, MetLife, Aetna, Humana, Guardian. Whitening promo: $199 this month.',
   true, true, true, array['whatsapp','sms']),
  ('20000000-0000-0000-0000-000000000004', 'Sam', 'chat', 'Sales', 'Draft', 'anthropic/claude-3.5-haiku',
   null, 'English', '',
   'You are Sam, a consultative sales assistant. You follow up on treatment plans that were presented but not accepted. Focus on value, financing options and answering objections. Never pressure; always offer a consult call.',
   'Financing: 12-month 0% via in-house plan on treatment over $1,000. Implant packages from $3,900. Veneers from $800/tooth.',
   false, false, false, array['whatsapp','email'])
on conflict do nothing;
