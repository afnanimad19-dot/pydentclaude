-- Pydent — migration 70: shared FXO line controller (Phase 2B).
--
-- NOT EXECUTED ANYWHERE YET: staged in supabase/pending/ for review only,
-- because supabase/migrations/ is a hash-pinned closed world
-- (scripts/a7-manifest.ts). Applying this file is a separately-approved step
-- that also moves it into migrations/ and re-pins the manifest. Additive and
-- idempotent; nothing existing is altered or dropped. Depends on nothing in
-- 0069 (the two can apply in either order), but both belong to the outbound
-- program. (The unmerged booking branch that provisionally used 0065–0068
-- renumbers AFTER this file: 0071+.)
--
-- Why this exists: the clinic has exactly ONE analog FXO line (D-Link Trunk1
-- port 1) shared between production inbound (Laura) and Pydent outbound
-- campaigns. These tables make outbound admission a database decision that is
-- atomic across workers, auditable, and fail-closed:
--
--   * shared_lines        — one row per physical line: maintenance switch,
--     cooldown, and the LAST TRUSTED OBSERVATION of the physical line state.
--     The observation is a scheduling input, NOT proof: an absent/stale/
--     untrusted observation reads as UNKNOWN and blocks outbound.
--   * line_reservations   — the single outbound slot. A partial unique index
--     makes "at most one holding reservation per line" a database constraint,
--     so two workers can never both win; the loser gets a unique violation.
--     idempotency_key is unique per workspace so a retried/duplicated request
--     can never create a second call.
--   * shared_line_events  — append-only audit of every state transition and
--     admission decision (campaign/lead/reservation/call attribution).
--
-- auto_outbound_enabled defaults FALSE and stays false until a reliable
-- physical line-state source exists (documented missing prerequisite): with
-- no trusted fresh observation the derived state is UNKNOWN and admission is
-- refused, so automated outbound initiation is structurally disabled.

create table if not exists public.shared_lines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace(),
  line_key text not null default 'fxo1',
  description text not null default 'D-Link DVX-2005F Trunk1 / FXO port 1 (+97143985241)',
  maintenance boolean not null default false,
  -- Future scheduler gate: stays false until a verified machine-readable
  -- FXO-state source exists. Supervised calls rely on operator attestation.
  auto_outbound_enabled boolean not null default false,
  cooldown_seconds int not null default 60,
  cooldown_until timestamptz,
  -- Last observation of the PHYSICAL line. Only a fresh 'idle' from a trusted
  -- source (shared-line.ts TRUSTED_LINE_OBSERVATION_SOURCES) admits a call.
  observed_state text not null default 'unknown',
  observed_at timestamptz,
  observed_source text not null default '',
  observed_ttl_seconds int not null default 120,
  observed_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists shared_lines_ws_key on public.shared_lines (workspace_id, line_key);
comment on table public.shared_lines is
  'One row per physical telephone line shared by inbound and outbound. The observation columns are the last trusted physical-state report; absent/stale means UNKNOWN which FAILS CLOSED.';

create table if not exists public.line_reservations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace(),
  line_id uuid not null references public.shared_lines(id) on delete cascade,
  campaign_id uuid,
  lead_id uuid,
  idempotency_key text not null,
  status text not null default 'reserved'
    check (status in ('reserved', 'dialing', 'active', 'released', 'expired', 'failed')),
  -- The voice_calls key ('lk:<room>') once a dial was started.
  call_key text not null default '',
  expires_at timestamptz not null,
  release_reason text not null default '',
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- THE single-line admission constraint: at most one reservation may hold the
-- line. Atomic across every Pydent worker — the second concurrent insert
-- fails with a unique violation (23505), which the controller surfaces as a
-- refusal instead of a second call.
create unique index if not exists line_reservations_one_holding_per_line
  on public.line_reservations (line_id) where status in ('reserved', 'dialing', 'active');
-- Duplicate requests (retries, double-clicks, replays) collapse onto the
-- original attempt instead of creating a second call.
create unique index if not exists line_reservations_idem
  on public.line_reservations (workspace_id, idempotency_key);
create index if not exists line_reservations_line_idx on public.line_reservations (line_id, status);
create index if not exists line_reservations_call_key_idx on public.line_reservations (workspace_id, call_key) where call_key <> '';
comment on table public.line_reservations is
  'Outbound admission slots. A reservation is a SCHEDULING control, never proof of physical line availability.';

create table if not exists public.shared_line_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace(),
  line_id uuid not null references public.shared_lines(id) on delete cascade,
  reservation_id uuid,
  campaign_id uuid,
  lead_id uuid,
  call_key text not null default '',
  from_state text not null default '',
  to_state text not null default '',
  reason text not null default '',
  -- 'system', a staff user id, or 'worker'. Never credentials or tokens.
  actor text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists shared_line_events_line_idx on public.shared_line_events (line_id, created_at desc);
comment on table public.shared_line_events is
  'Append-only audit of shared-line state transitions and admission decisions.';

alter table if exists public.shared_lines enable row level security;
alter table if exists public.line_reservations enable row level security;
alter table if exists public.shared_line_events enable row level security;

-- Workspace isolation from day one (the 0050 shape — no open-demo phase).
do $$ begin
  create policy "workspace isolation" on public.shared_lines
    for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "workspace isolation" on public.line_reservations
    for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy "workspace isolation" on public.shared_line_events
    for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
exception when duplicate_object then null; end $$;
