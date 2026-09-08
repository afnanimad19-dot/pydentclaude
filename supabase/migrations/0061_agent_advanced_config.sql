-- Pydent — migration 61: advanced voice-agent configuration + call observability.
--
-- Agent configuration itself lives in the existing `agents.voice_settings`
-- JSONB blob (added long ago), so no per-setting columns are needed: the
-- normalizer in src/lib/agent-config.ts fills defaults for any key an older
-- agent is missing, which keeps every existing agent working untouched.
--
-- What this migration adds is storage for what a call PRODUCES:
--   * extracted_data   — the Post-Call Data Extraction results for that call
--   * latency_metrics  — per-turn EOU / STT / LLM TTFT / TTS TTFB / E2E metrics
--   * config_version   — which agent-config schema version ran the call
-- Idempotent and safe to re-run.

alter table voice_calls add column if not exists extracted_data jsonb not null default '{}'::jsonb;
alter table voice_calls add column if not exists latency_metrics jsonb not null default '{}'::jsonb;
alter table voice_calls add column if not exists config_version integer not null default 1;

comment on column voice_calls.extracted_data is 'Post-call structured extraction results, keyed by the agent''s configured field names.';
comment on column voice_calls.latency_metrics is 'Per-turn latency observability: turns[] plus averages (eou, stt, llm_ttft, tts_ttfb, e2e).';

-- Agents created before advanced config simply have {} / missing keys; the
-- normalizer supplies documented defaults at read time. Nothing is overwritten.
