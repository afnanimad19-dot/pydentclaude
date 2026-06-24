-- Pydent — migration 28: connection access mode (read-only vs read & write).
-- Lets each clinic choose what a connected integration is allowed to do.
-- Idempotent. Run in a fresh SQL tab.

alter table connections add column if not exists access_mode text not null default 'read';
