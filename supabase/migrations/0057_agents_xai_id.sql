-- Pydent voice agents are mirrored into the xAI console (Voice → Agents) via
-- the xAI Agents API, like the existing Vapi sync. Store the xAI agent id so
-- re-saves UPDATE the same console agent instead of creating duplicates.
alter table if exists agents
  add column if not exists xai_agent_id text default '';
