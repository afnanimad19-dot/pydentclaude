-- Pydent — migration 64: provider-aware phone-number routing + assignment audit.
--
-- NOT APPLIED AUTOMATICALLY. Review, then run in the Supabase SQL Editor.
-- Additive and idempotent: it only ADDS columns (with safe defaults), indexes,
-- one audit table and two guard triggers. It does not rename or drop anything.
--
-- Why: until now `voice_numbers.agent_id` was only a database label. Changing
-- it never changed which AI agent actually answers a LiveKit-routed number, so
-- the UI could show one agent while calls reached another. This migration
-- records WHICH provider object routes each number, which agent that object was
-- last VERIFIED to dispatch, and an audit trail with before/after provider
-- snapshots so every reassignment can be rolled back exactly.
--
-- Routing ownership:
--   routing_provider         'none'    — database label only, no provider routing managed by Pydent
--                            'livekit' — an existing inbound trunk + dispatch rule, linked after read-only verification
--                            'vapi'    — a Vapi phone number (vapi_phone_number_id)
--   livekit_trunk_id / livekit_dispatch_rule_id — the linked LiveKit objects (never recreated by reassignment)
--   routing_agent_id         the agent the provider was last verified to dispatch
--   routing_status           unverified | synced | pending | failed | reconcile_needed
--   routing_protected        production number: reassignment needs explicit typed confirmation,
--                            and the row cannot be deleted or its routing edited from the browser
--   assignment_version       compare-and-set counter (concurrency protection)
--   assignment_lock_until    short lease held while a provider update is in flight
--
-- Only the server (service role) may change routing columns, or agent_id on a
-- provider-routed number; the browser (anon/authenticated key) is refused by
-- the guard trigger below. Existing RLS (workspace isolation) is unchanged.

alter table public.voice_numbers add column if not exists routing_provider text not null default 'none';
alter table public.voice_numbers add column if not exists livekit_trunk_id text;
alter table public.voice_numbers add column if not exists livekit_dispatch_rule_id text;
alter table public.voice_numbers add column if not exists routing_agent_id uuid;
alter table public.voice_numbers add column if not exists routing_status text not null default 'unverified';
alter table public.voice_numbers add column if not exists routing_verified_at timestamptz;
alter table public.voice_numbers add column if not exists routing_error text;
alter table public.voice_numbers add column if not exists routing_protected boolean not null default false;
alter table public.voice_numbers add column if not exists assignment_version integer not null default 0;
alter table public.voice_numbers add column if not exists assignment_lock_until timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'voice_numbers_routing_provider_chk') then
    alter table public.voice_numbers add constraint voice_numbers_routing_provider_chk
      check (routing_provider in ('none', 'livekit', 'vapi'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'voice_numbers_routing_status_chk') then
    alter table public.voice_numbers add constraint voice_numbers_routing_status_chk
      check (routing_status in ('unverified', 'synced', 'pending', 'failed', 'reconcile_needed'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'voice_numbers_livekit_link_chk') then
    alter table public.voice_numbers add constraint voice_numbers_livekit_link_chk
      check (routing_provider <> 'livekit' or (livekit_trunk_id is not null and livekit_dispatch_rule_id is not null));
  end if;
end $$;

-- A provider routing object can back exactly ONE number row, across ALL
-- workspaces — two rows (or two clinics) can never both claim the same rule.
create unique index if not exists voice_numbers_livekit_rule_uniq
  on public.voice_numbers (livekit_dispatch_rule_id) where livekit_dispatch_rule_id is not null;
create unique index if not exists voice_numbers_vapi_number_uniq
  on public.voice_numbers (vapi_phone_number_id) where vapi_phone_number_id is not null;

-- Numbers already registered on Vapi by Pydent (a stored Vapi phone-number id)
-- are Vapi-routed. Deterministic: touches only rows that still say 'none' and
-- carry an explicit Vapi id; LiveKit routing is NEVER inferred — it must be
-- linked through the verified "link existing" action.
update public.voice_numbers
  set routing_provider = 'vapi'
  where routing_provider = 'none' and vapi_phone_number_id is not null;

-- ---------------------------------------------------------------- audit trail
create table if not exists public.voice_number_assignments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  voice_number_id uuid not null references public.voice_numbers(id) on delete cascade,
  action text not null,                    -- reassign | rollback | link | reconcile
  provider text not null,                  -- none | livekit | vapi
  from_agent_id uuid,
  to_agent_id uuid,
  actor_user_id uuid,
  idempotency_key text not null,
  status text not null default 'pending',  -- pending | applied | failed | rolled_back | reconcile_needed
  provider_before jsonb,                   -- provider routing snapshot before the change (dispatch rule / Vapi assistant)
  provider_after jsonb,                    -- the snapshot that was written and verified
  error text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint voice_number_assignments_action_chk check (action in ('reassign', 'rollback', 'link', 'reconcile')),
  constraint voice_number_assignments_status_chk check (status in ('pending', 'applied', 'failed', 'rolled_back', 'reconcile_needed'))
);
create unique index if not exists voice_number_assignments_idem
  on public.voice_number_assignments (workspace_id, idempotency_key);
create index if not exists voice_number_assignments_number_idx
  on public.voice_number_assignments (voice_number_id, created_at desc);

-- Read-only for the workspace in the browser; only the server writes it.
alter table public.voice_number_assignments enable row level security;
drop policy if exists "workspace read assignments" on public.voice_number_assignments;
create policy "workspace read assignments" on public.voice_number_assignments
  for select using (workspace_id = current_workspace());

-- ------------------------------------------------------------- guard triggers
-- The browser key can still edit a number's nickname / config / direction, and
-- (for database-only numbers) its agent label — but never the routing columns,
-- and never agent_id on a provider-routed number. Service role and the SQL
-- editor (no JWT role) are unaffected.
create or replace function public.voice_numbers_guard_routing() returns trigger
language plpgsql as $$
declare jwt_role text := coalesce(auth.role(), '');
begin
  if jwt_role not in ('anon', 'authenticated') then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.routing_protected or old.routing_provider = 'livekit' then
      raise exception 'This number has provider routing managed by Pydent and cannot be deleted from the browser.';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.routing_provider <> 'none' or new.livekit_trunk_id is not null or new.livekit_dispatch_rule_id is not null
       or new.routing_agent_id is not null or new.routing_protected or new.routing_status <> 'unverified'
       or new.assignment_version <> 0 or new.assignment_lock_until is not null
       or new.vapi_phone_number_id is not null then
      raise exception 'Routing fields can only be set by the server.';
    end if;
    return new;
  end if;
  -- UPDATE
  if new.routing_provider is distinct from old.routing_provider
     or new.livekit_trunk_id is distinct from old.livekit_trunk_id
     or new.livekit_dispatch_rule_id is distinct from old.livekit_dispatch_rule_id
     or new.routing_agent_id is distinct from old.routing_agent_id
     or new.routing_status is distinct from old.routing_status
     or new.routing_verified_at is distinct from old.routing_verified_at
     or new.routing_error is distinct from old.routing_error
     or new.routing_protected is distinct from old.routing_protected
     or new.assignment_version is distinct from old.assignment_version
     or new.assignment_lock_until is distinct from old.assignment_lock_until
     or new.vapi_phone_number_id is distinct from old.vapi_phone_number_id then
    raise exception 'Routing fields can only be changed by the server.';
  end if;
  if old.routing_provider <> 'none' and new.agent_id is distinct from old.agent_id then
    raise exception 'This number is provider-routed — reassign it from Voice Agent Settings.';
  end if;
  if old.routing_provider <> 'none' and new.number is distinct from old.number then
    raise exception 'The phone number of a provider-routed line cannot be edited from the browser.';
  end if;
  return new;
end $$;

drop trigger if exists voice_numbers_guard_routing on public.voice_numbers;
create trigger voice_numbers_guard_routing
  before insert or update or delete on public.voice_numbers
  for each row execute function public.voice_numbers_guard_routing();

-- Rollback of THIS migration (manual, only if never used in production):
--   drop trigger if exists voice_numbers_guard_routing on public.voice_numbers;
--   drop function if exists public.voice_numbers_guard_routing();
--   drop table if exists public.voice_number_assignments;
--   drop index if exists voice_numbers_livekit_rule_uniq; drop index if exists voice_numbers_vapi_number_uniq;
--   alter table public.voice_numbers drop constraint if exists voice_numbers_routing_provider_chk,
--     drop constraint if exists voice_numbers_routing_status_chk, drop constraint if exists voice_numbers_livekit_link_chk,
--     drop column if exists routing_provider, drop column if exists livekit_trunk_id,
--     drop column if exists livekit_dispatch_rule_id, drop column if exists routing_agent_id,
--     drop column if exists routing_status, drop column if exists routing_verified_at,
--     drop column if exists routing_error, drop column if exists routing_protected,
--     drop column if exists assignment_version, drop column if exists assignment_lock_until;
