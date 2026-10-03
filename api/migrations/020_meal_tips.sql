-- Recipe tips: each meal's "Common mistakes" (split out of its steps when the
-- meal library is seeded).
ALTER TABLE meals ADD COLUMN IF NOT EXISTS tips text[] NOT NULL DEFAULT '{}';
