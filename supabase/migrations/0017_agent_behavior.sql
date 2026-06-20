-- Pydental — migration 17: separate "behavior" guidance on agents (distinct from
-- instructions). Run in Supabase SQL Editor.

alter table agents add column if not exists behavior text default '';
