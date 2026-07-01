-- Persist manually-added pipeline deals (they used to be session-only and reset on
-- reload). Live WhatsApp leads already persist via wa_conversations.lifecycle; this
-- covers the cards a user adds by hand. Idempotent + demo-open RLS.

create table if not exists public.pipeline_deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references public.workspaces(id) on delete cascade,
  patient_name text not null default '',
  treatment text default '',
  value numeric default 0,
  source text default 'manual',
  owner text default '',
  stage_name text not null default 'New Lead',
  created_at timestamptz default now()
);

create index if not exists pipeline_deals_ws_idx on public.pipeline_deals (workspace_id);

alter table if exists public.pipeline_deals enable row level security;
do $$ begin
  create policy pipeline_deals_all on public.pipeline_deals for all using (true) with check (true);
exception when duplicate_object then null; end $$;
