-- COPPA: features that send a child's words to an AI provider (the homework
-- helper, lecture notes) stay off for kids under 13 (or of unknown age) until a
-- parent turns them on. Recorded with who consented and when; withdrawable.
ALTER TABLE household_members
  ADD COLUMN IF NOT EXISTS ai_consent_at timestamptz,
  ADD COLUMN IF NOT EXISTS ai_consent_by integer REFERENCES household_members(id) ON DELETE SET NULL;
