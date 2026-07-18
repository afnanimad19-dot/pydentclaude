-- Open Dental's own API authenticates with a Developer API Key + Customer API
-- Key via the header  Authorization: ODFHIR {DeveloperKey}/{CustomerKey}.
-- Store the developer key alongside the existing per-clinic customer key.
alter table if exists opendental_config
  add column if not exists developer_key text default '';
