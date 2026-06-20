-- Pydental — migration 18: prevent duplicate inbound messages (Meta sometimes
-- retries the webhook, causing the agent to reply twice). Run in SQL Editor.

create unique index if not exists wa_messages_msgid_uniq
  on wa_messages (wa_message_id) where wa_message_id is not null;
