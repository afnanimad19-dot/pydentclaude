-- Brand Identity: richer, structured brand knowledge for a clinic — doctors,
-- services, contacts, socials, brand voice — stored as one JSON blob so new
-- fields can be added without further migrations. The human-readable summary is
-- still composed into brand_knowledge.profile (which the AI agents already read).
alter table if exists brand_knowledge
  add column if not exists details jsonb default '{}'::jsonb;
