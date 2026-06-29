-- Instagram auto-publish: let the scheduler claim ('Publishing'), record success
-- ('Published' + media id) or failure ('Failed' + error), and store the public
-- image URL it used. Idempotent.

alter table if exists public.ig_posts drop constraint if exists ig_posts_status_check;
alter table if exists public.ig_posts
  add constraint ig_posts_status_check
  check (status in ('Draft', 'Scheduled', 'Publishing', 'Published', 'Failed'));

alter table if exists public.ig_posts
  add column if not exists ig_media_id text,
  add column if not exists image_url text,
  add column if not exists error text default '',
  add column if not exists published_at timestamptz;
