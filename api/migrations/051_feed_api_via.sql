-- The Feed Publishing API: posts and photos an app made for someone carry the app ("via Scheduler A").
-- via_app_id links the live app (its current name is shown); via_name keeps the name it had when it
-- posted, so attribution survives the app being deleted. Both NULL = made in The Feed itself.
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS via_app_id integer REFERENCES feed_api_apps(id) ON DELETE SET NULL;
ALTER TABLE social_posts ADD COLUMN IF NOT EXISTS via_name text;
ALTER TABLE community_images ADD COLUMN IF NOT EXISTS via_app_id integer REFERENCES feed_api_apps(id) ON DELETE SET NULL;
-- Per-app quotas count these (lib/feedapi-limits.ts).
CREATE INDEX IF NOT EXISTS social_posts_via_idx ON social_posts (via_app_id, created_at) WHERE via_app_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS community_images_via_idx ON community_images (via_app_id, created_at) WHERE via_app_id IS NOT NULL;
