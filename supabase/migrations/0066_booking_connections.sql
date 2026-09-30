-- Pydent — migration 66: BOOKING CONNECTIONS + EXTERNAL MAPPINGS (M1B —
-- PROPOSED, NOT YET APPLIED TO ANY ENVIRONMENT).
--
-- The generic multi-PMS data foundation:
--
--   workspace ──< booking_connections        which booking system(s) a clinic
--                    │                       uses (Open Dental, D4W, Pydent
--                    │                       native, future PMS)
--                    ├── booking_connection_secrets   credentials, SERVER-ONLY
--                    ├──< external_mappings  Pydent entity ↔ external PMS
--                    │                       identity (ProvNum, OpNum, AptNum,
--                    │                       D4W ids, … all live in external_id
--                    │                       — never as dedicated columns)
--                    └──< booking_sync_runs  sync/import run log & state
--
-- Data foundation ONLY: no connector abstraction, no synchronization engine,
-- and no behavior change anywhere. opendental_config and
-- appointments.external_id are untouched and keep operating exactly as
-- before; later milestones dual-write into external_mappings during the
-- transition.
--
-- Conventions (as migrations 0014/0050/0065):
--  * workspace_id: not null, default current_workspace(), cascade on
--    workspace delete. (Exception: booking_connection_secrets takes NO
--    default — it is written by service-role server code only, where
--    current_workspace() has no auth context; the writer supplies it.)
--  * RLS: strict workspace-isolation policy on every browser-visible table.
--    booking_connection_secrets gets RLS ENABLED WITH NO POLICY AT ALL — the
--    exact oauth_tokens pattern (migration 0026): the anon/authenticated
--    browser client can never read or write it, only the service-role server
--    client can.
--  * Workspace consistency is RELATIONAL, not conventional:
--    booking_connections declares unique (id, workspace_id), and every child
--    table (secrets, external_mappings, booking_sync_runs) references that
--    pair through a composite FK — so a child row can never pair workspace
--    A's id with workspace B's connection, whatever any writer does.
--  * connector_type / entity_type / sync_type / status are free text with NO
--    CHECK constraint, deliberately: adding a new PMS or entity type must
--    never require a schema migration. The closed vocabularies live in the
--    application layer (src/lib/booking-connections-server.ts).
--
-- Risk assessment:
--  * Purely additive: four new tables, no existing table touched, no
--    backfill. Idempotent — safe to re-run.
--  * One enabled PRIMARY connection per workspace is enforced by a partial
--    unique index (secondary/disabled connections stay unlimited).
--  * Rollback: drop booking_sync_runs, external_mappings,
--    booking_connection_secrets, then booking_connections (FK order).

-- ------------------------------------------------------ booking_connections
create table if not exists public.booking_connections (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace() references public.workspaces(id) on delete cascade,
  connector_type text not null,           -- 'pydent_native' | 'opendental' | 'd4w' | future — app-validated
  display_name text default '',
  enabled boolean not null default true,
  is_primary boolean not null default false,
  config jsonb not null default '{}'::jsonb,  -- NON-SECRET configuration only (secrets live in booking_connection_secrets)
  last_sync_at timestamptz,
  sync_status text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- (id, workspace_id) is unique by construction (id is the PK); declaring it
  -- lets every child table use a composite FK that makes a cross-workspace
  -- (connection, workspace) pair IMPOSSIBLE at the database level.
  constraint booking_connections_id_ws_uq unique (id, workspace_id)
);
create index if not exists booking_connections_ws_idx on public.booking_connections (workspace_id);
-- A workspace has at most ONE enabled primary booking system; disabled or
-- secondary connections are not limited.
create unique index if not exists booking_connections_one_primary_idx
  on public.booking_connections (workspace_id) where (is_primary and enabled);

alter table public.booking_connections enable row level security;
drop policy if exists "workspace isolation" on public.booking_connections;
create policy "workspace isolation" on public.booking_connections
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());

-- ---------------------------------------------- booking_connection_secrets
-- Connector credentials (API keys, tokens). SERVER-ONLY: RLS is enabled and
-- NO policy is created, so the browser (anon/authenticated) can never touch
-- it — only the service-role client (src/lib/supabase-admin.ts) can, exactly
-- like oauth_tokens. Existing Open Dental credentials are NOT migrated here
-- in M1B; opendental_config keeps working unchanged.
create table if not exists public.booking_connection_secrets (
  connection_id uuid primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  credentials jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- The COMPOSITE FK (replacing a single-column connection FK) forces the
  -- pair to name an existing connection in the SAME workspace: a secrets row
  -- for workspace A can never reference workspace B's connection.
  constraint booking_connection_secrets_conn_ws_fk
    foreign key (connection_id, workspace_id)
    references public.booking_connections (id, workspace_id) on delete cascade
);
create index if not exists booking_connection_secrets_ws_idx on public.booking_connection_secrets (workspace_id);
alter table public.booking_connection_secrets enable row level security;
-- Intentionally NO create policy here.

-- -------------------------------------------------------- external_mappings
-- Generic identity bridge: one Pydent entity ↔ one external PMS entity, per
-- connection. pydent_entity_id is intentionally NOT a foreign key — it can
-- reference a provider, operatory, appointment, patient, service, or future
-- entity types; entity_type says which. External identifiers of every PMS
-- (Open Dental ProvNum/OpNum/AptNum, D4W ids, …) are stored in external_id —
-- this table never grows PMS-specific columns.
create table if not exists public.external_mappings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace() references public.workspaces(id) on delete cascade,
  connection_id uuid not null,
  entity_type text not null,              -- 'provider' | 'operatory' | 'appointment' | 'patient' | 'service' | future
  pydent_entity_id uuid not null,         -- polymorphic — no FK by design
  external_id text not null,
  external_type text,
  external_updated_at timestamptz,
  last_synced_at timestamptz,
  sync_status text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Composite FK: the mapping's connection must live in the SAME workspace.
  constraint external_mappings_conn_ws_fk
    foreign key (connection_id, workspace_id)
    references public.booking_connections (id, workspace_id) on delete cascade
);
-- One external identity maps to at most one Pydent entity per connection…
create unique index if not exists external_mappings_external_uq
  on public.external_mappings (connection_id, entity_type, external_id);
-- …and one Pydent entity holds at most one mapping per connection + entity
-- type (re-syncs must UPDATE the existing row, never accumulate duplicates).
create unique index if not exists external_mappings_pydent_uq
  on public.external_mappings (connection_id, entity_type, pydent_entity_id);
create index if not exists external_mappings_ws_idx on public.external_mappings (workspace_id, entity_type, pydent_entity_id);

alter table public.external_mappings enable row level security;
drop policy if exists "workspace isolation" on public.external_mappings;
create policy "workspace isolation" on public.external_mappings
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());

-- --------------------------------------------------------- booking_sync_runs
-- Lightweight log/state for future imports, incremental syncs and
-- reconciliations (no sync engine exists yet — M1B only records the shape).
-- detail carries diagnostics ONLY: never secrets, never clinical data, and no
-- more patient data than a run summary strictly needs.
create table if not exists public.booking_sync_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null default current_workspace() references public.workspaces(id) on delete cascade,
  connection_id uuid not null,
  sync_type text not null,                -- 'initial_import' | 'incremental' | 'reconciliation' | 'provider_import' | … app-validated
  status text not null default 'running', -- 'running' | 'succeeded' | 'failed' | 'partial' — app-validated
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  records_read integer not null default 0,
  records_written integer not null default 0,
  records_failed integer not null default 0,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  -- Composite FK: the run's connection must live in the SAME workspace.
  constraint booking_sync_runs_conn_ws_fk
    foreign key (connection_id, workspace_id)
    references public.booking_connections (id, workspace_id) on delete cascade
);
create index if not exists booking_sync_runs_ws_idx on public.booking_sync_runs (workspace_id, connection_id, started_at desc);

alter table public.booking_sync_runs enable row level security;
drop policy if exists "workspace isolation" on public.booking_sync_runs;
create policy "workspace isolation" on public.booking_sync_runs
  for all using (workspace_id = current_workspace()) with check (workspace_id = current_workspace());
