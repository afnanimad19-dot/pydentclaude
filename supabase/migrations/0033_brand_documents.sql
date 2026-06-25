-- Pydent — migration 33: brand knowledge documents.
-- Clinics upload as many brand docs as they want (any type); the extracted text
-- becomes part of every AI Team agent's brand knowledge. Idempotent.

create table if not exists brand_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid default current_workspace() references workspaces(id) on delete cascade,
  name text not null default 'Document',
  content text default '',
  created_at timestamptz not null default now()
);
create index if not exists brand_documents_ws_idx on brand_documents (workspace_id, created_at desc);
alter table brand_documents enable row level security;
drop policy if exists "demo open access" on brand_documents;
create policy "demo open access" on brand_documents for all using (true) with check (true);
