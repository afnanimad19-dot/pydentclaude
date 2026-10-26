-- Pydent — migration 71: outbound call queue + calling hours (fast-track
-- Phase 4).
--
-- NOT EXECUTED ANYWHERE YET: staged in supabase/pending/ for review only
-- (supabase/migrations/ is a hash-pinned closed world; applying is a
-- separately-approved step that moves this file and re-pins the manifest).
-- Additive and idempotent. (The unmerged booking branch renumbers AFTER this
-- file: 0072+.)
--
-- The queue is a SCHEDULING layer on top of the existing campaign machinery —
-- it never dials by itself. Each item names a campaign lead; running a due
-- item goes through the full guarded path (campaign approval → verified
-- eligibility → DNC → calling hours → shared-line admission → atomic line
-- reservation → recording-before-dial). Kinds cover reminders,
-- confirmations, follow-ups, missed-call callbacks and approved outreach;
-- the consent basis is recorded per item for the audit trail.

alter table campaigns add column if not exists calling_hours jsonb not null default '{}'::jsonb;
comment on column campaigns.calling_hours is
  'Calling-hours policy {tz, start:"HH:MM", end:"HH:MM", days:[1..6]} — empty = the conservative default (Asia/Dubai, Mon–Sat 09:00–18:00). Enforced before every queued dial.';

create table if not exists public.call_queue (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  lead_id uuid not null,
  kind text not null default 'campaign'
    check (kind in ('campaign', 'reminder', 'confirmation', 'followup', 'callback', 'outreach')),
  -- Documented lawful basis for THIS call (display/audit; the dialable gate
  -- stays the lead's attested eligibility + DNC).
  consent_basis text not null default '',
  status text not null default 'scheduled'
    check (status in ('scheduled', 'calling', 'done', 'failed', 'cancelled', 'expired')),
  scheduled_at timestamptz not null,
  -- The item expires unused after this moment (e.g. a reminder is pointless
  -- after the appointment itself).
  not_after timestamptz,
  attempts int not null default 0,
  max_attempts int not null default 2,
  retry_backoff_minutes int not null default 120,
  last_call_key text not null default '',
  last_outcome text not null default '',
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists call_queue_due_idx on public.call_queue (workspace_id, status, scheduled_at);
-- Duplicate-call prevention at the queue layer: one live queue item per lead.
create unique index if not exists call_queue_one_live_per_lead
  on public.call_queue (lead_id) where status in ('scheduled', 'calling');

alter table if exists public.call_queue enable row level security;
do $$ begin
  create policy "workspace isolation" on public.call_queue
    for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
exception when duplicate_object then null; end $$;
