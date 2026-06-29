-- Persist clinic tags (labels for contacts/conversations). Idempotent + demo-open RLS.

create table if not exists public.clinic_tags (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete cascade,
  name text not null,
  color text default '#7c3aed',
  created_at timestamptz default now()
);

alter table if exists public.clinic_tags enable row level security;

do $$ begin
  create policy clinic_tags_all on public.clinic_tags for all using (true) with check (true);
exception when duplicate_object then null;
end $$;
