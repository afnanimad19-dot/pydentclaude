-- Pydent — migration 27: per-clinic "show sample data" flag.
-- Lets a real clinic hide the built-in demo/sample data so their dashboard shows
-- only their own records. Default true (keeps the sample data for new/demo accounts).
-- Idempotent. Run in a fresh SQL tab.

alter table clinic_settings add column if not exists show_sample_data boolean not null default true;
