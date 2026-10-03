-- Progress photos: opt-in, adults only, visible to their owner alone.
-- Stored in the database (encrypted, AES-256-GCM) so they are covered by the
-- nightly backup and by row-level security, and move with a household merge.
ALTER TABLE health_profiles ADD COLUMN IF NOT EXISTS photos boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS progress_photos (
  id         serial PRIMARY KEY,
  member_id  integer NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
  taken_on   date NOT NULL,
  pose       text NOT NULL CHECK (pose IN ('front', 'back', 'left', 'right')),
  mime       text NOT NULL,
  -- iv(12) || tag(16) || ciphertext
  data       bytea NOT NULL,
  -- Which key encrypted it: 'p' = PHOTO_KEY, 's' = derived from SESSION_SECRET.
  key_id     text NOT NULL DEFAULT 'p',
  bytes      integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (member_id, taken_on, pose)
);
CREATE INDEX IF NOT EXISTS progress_photos_member_idx ON progress_photos (member_id, taken_on);
SELECT myday_tenant('progress_photos');
