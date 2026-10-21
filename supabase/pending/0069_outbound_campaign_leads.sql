-- Pydent — migration 69: LiveKit outbound campaigns (Phase 2A prep).
--
-- NOT EXECUTED ANYWHERE YET: prepared for review only, staged in
-- supabase/pending/ because supabase/migrations/ is a hash-pinned closed
-- world (scripts/a7-manifest.ts). Applying this file is a separately-approved
-- step that also moves it into migrations/ and re-reviews the manifest.
-- Additive and idempotent; nothing existing is altered or dropped. (The
-- unmerged booking branch that provisionally used 0065–0068 renumbers after
-- this file: 0070+.)
--
-- What this adds, per the approved outbound design:
--   * campaigns.approved_at / approved_by — the explicit human approval gate:
--     the dialer refuses every campaign where approved_at is null.
--     campaigns.halted_reason — set by the dialer (e.g. after 3 consecutive
--     recording failures, policy P2); cleared by staff to resume.
--   * voice_numbers.livekit_outbound_trunk_id — the LiveKit OUTBOUND SIP trunk
--     for this number. Server-written only; empty = outbound disabled for the
--     number (the dialer fails closed).
--   * campaign_leads — one row per person a campaign may call. Three consent
--     facts are tracked SEPARATELY, and none is ever inferred from another:
--       marketing_eligible_at/_source — verified eligibility for automated
--         promotional calls (NOT patient-registration consent; the dialer
--         refuses leads where this is null — fail closed);
--       opening_consent(_at) — the recipient's recorded answer to the
--         mandatory opening disclosure (recording notice + "may we continue");
--       do-not-call lives in voice_dnc (below), not on the lead.
--     Recording consent/configuration stays a separate concern entirely
--     (voice_settings.recordCalls + RECORDING_AZURE_*).
--   * voice_dnc — permanent opt-out registry. Deliberately NOT referenced to
--     campaigns: deleting a campaign never deletes an opt-out.
--
-- Recordings themselves follow migration 0063 unchanged (private Azure paths
-- on voice_calls.recording_*); proposed routine retention is 30 days, pending
-- clinic/legal approval (P3) — no lifecycle rule is created by this file.

alter table campaigns add column if not exists approved_at timestamptz;
alter table campaigns add column if not exists approved_by uuid;
alter table campaigns add column if not exists halted_reason text not null default '';

alter table voice_numbers add column if not exists livekit_outbound_trunk_id text not null default '';
comment on column voice_numbers.livekit_outbound_trunk_id is
  'LiveKit outbound SIP trunk id for this number. Server-written only; empty = no outbound dialing.';

create table if not exists public.campaign_leads (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace(),
  campaign_id uuid not null references public.campaigns(id) on delete cascade,
  patient_id uuid,
  phone text not null,
  status text not null default 'pending'
    check (status in ('pending', 'claimed', 'calling', 'done', 'failed', 'blocked')),
  -- Machine-readable refusal/failure detail, e.g. 'recording_unavailable',
  -- 'not_marketing_eligible', 'do_not_call', 'sip_failed', 'recording_failed'.
  status_detail text not null default '',
  attempts int not null default 0,
  marketing_eligible_at timestamptz,
  marketing_eligibility_source text not null default '',
  opening_consent text not null default ''
    check (opening_consent in ('', 'accepted', 'declined', 'opt_out', 'no_answer', 'unclear')),
  opening_consent_at timestamptz,
  -- The voice_calls key ('lk:<room>') of the most recent attempt.
  last_call_key text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.campaign_leads.marketing_eligible_at is
  'Verified eligibility for AUTOMATED PROMOTIONAL calls. Null = never dial (fail closed). Patient registration consent does NOT populate this.';
comment on column public.campaign_leads.opening_consent is
  'Recipient''s recorded answer to the mandatory opening disclosure (recording notice + request to continue).';

create table if not exists public.voice_dnc (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace(),
  phone text not null,
  source text not null default '',
  created_at timestamptz not null default now()
);
create unique index if not exists voice_dnc_ws_phone_uniq on public.voice_dnc (workspace_id, phone);
comment on table public.voice_dnc is
  'Permanent do-not-call registry. No campaign reference on purpose: opt-outs survive campaign deletion.';

create index if not exists campaign_leads_campaign_idx on public.campaign_leads (campaign_id, status);
create index if not exists campaign_leads_ws_idx on public.campaign_leads (workspace_id);
create index if not exists voice_calls_campaign_idx on voice_calls (campaign_id) where campaign_id is not null;

alter table if exists public.campaign_leads enable row level security;
alter table if exists public.voice_dnc enable row level security;

-- Workspace isolation from day one (the 0050 shape — no open-demo phase).
do $$ begin
  create policy "workspace isolation" on public.campaign_leads
    for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "workspace isolation" on public.voice_dnc
    for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
exception when duplicate_object then null; end $$;
