-- Offline recordings: the phone gives each recording an id, so a retried
-- upload (the answer got lost on a bad connection) never makes a second lecture.
ALTER TABLE lectures ADD COLUMN IF NOT EXISTS client_id text;
CREATE UNIQUE INDEX IF NOT EXISTS lectures_member_client_idx ON lectures (member_id, client_id) WHERE client_id IS NOT NULL;
