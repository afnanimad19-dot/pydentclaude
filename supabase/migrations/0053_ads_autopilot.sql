-- Pydental — migration 53: Meta ads recommendation autopilot.
-- Per-clinic toggle: when ON, the cron scans Meta's recommendations/errors on
-- the clinic's campaigns and sends creative-fatigue-type recommendations to
-- Helena, who generates a fresh creative and prepares a paused replacement ad.
-- autopilot_seen remembers which recommendations were already handled.

alter table hyperfx_config add column if not exists auto_recommendations boolean not null default false;
alter table hyperfx_config add column if not exists autopilot_seen jsonb not null default '[]'::jsonb;
