-- Households choose which optional parts of MyDay they see (Settings → What's
-- in your MyDay). Existing households keep everything on.
ALTER TABLE households ADD COLUMN IF NOT EXISTS modules_off text[] NOT NULL DEFAULT '{}';
