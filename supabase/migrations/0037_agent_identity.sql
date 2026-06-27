-- Pydent — migration 37: Callab-style "Prompt Configuration" on agents. The prompt
-- is now three parts: Agent Identity (new), Tasks (= existing `instructions`),
-- Style Guardrails (= existing `behavior`). This adds the identity column.
-- Run in Supabase SQL Editor. Idempotent, no ON CONFLICT.

alter table agents add column if not exists agent_identity text default '';
