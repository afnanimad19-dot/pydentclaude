-- Content Calendar (Later.com-style): the ig_posts table becomes multi-platform.
-- platforms = which networks to publish to (csv, e.g. 'instagram,facebook').
-- media_url = a public URL of the user's uploaded/chosen media (image/video).
-- (image_url already exists and holds the runner-resolved hosted image.)
alter table if exists ig_posts
  add column if not exists platforms text default 'instagram',
  add column if not exists media_url text default '';
