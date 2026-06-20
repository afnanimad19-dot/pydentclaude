-- Pydental — migration 5: workflows (automation canvas).
-- Run in Supabase Dashboard → SQL Editor.

create table if not exists workflows (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  channel text not null default 'whatsapp',
  status text not null default 'Draft' check (status in ('Live','Paused','Draft')),
  nodes jsonb not null default '[]'::jsonb,  -- [{id,type,title,detail}]
  triggered_today integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table workflows enable row level security;
drop policy if exists "demo open access" on workflows;
create policy "demo open access" on workflows for all using (true) with check (true);

-- Seed the three flows that previously lived in the chatbot builder
insert into workflows (id, name, channel, status, triggered_today, nodes) values
  ('40000000-0000-0000-0000-000000000001', 'Hygiene recall & rebooking', 'whatsapp', 'Live', 38, '[
    {"id":"n1","type":"trigger","title":"Trigger: recall due","detail":"Patient overdue for hygiene ≥ 30 days"},
    {"id":"n2","type":"message","title":"Send recall message","detail":"Template: “Hi {{first_name}}, you''re due for your cleaning…” with 3 slot buttons"},
    {"id":"n3","type":"condition","title":"Patient replied?","detail":"Wait 24h → if no reply, retry once; after 2nd silence, queue voice call"},
    {"id":"n4","type":"action","title":"Book appointment","detail":"Create appointment in the chosen slot"},
    {"id":"n5","type":"message","title":"Confirmation + reminder","detail":"Send instant confirmation, reminder at T-24h and T-2h"}
  ]'::jsonb),
  ('40000000-0000-0000-0000-000000000002', 'FAQ & office-hours autoresponder', 'whatsapp', 'Live', 17, '[
    {"id":"n1","type":"trigger","title":"Trigger: inbound message","detail":"Any WhatsApp message outside an active conversation"},
    {"id":"n2","type":"agent","title":"AI agent answers","detail":"Assigned chat agent replies from its knowledge base"},
    {"id":"n3","type":"handoff","title":"Human handoff","detail":"Unresolved after 2 turns → assign to Front Desk inbox with full context"}
  ]'::jsonb),
  ('40000000-0000-0000-0000-000000000003', 'No-show recovery', 'sms', 'Paused', 0, '[
    {"id":"n1","type":"trigger","title":"Trigger: appointment broken","detail":"Appointment status changes to Broken"},
    {"id":"n2","type":"message","title":"Empathetic rebook text","detail":"“We missed you today — want to grab a new time?” with booking link"},
    {"id":"n3","type":"condition","title":"Booked within 48h?","detail":"If not, add to Pipeline → Contacted and notify Front Desk"}
  ]'::jsonb)
on conflict do nothing;
