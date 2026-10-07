-- Homework help style, per kid: hints first (default) or direct answers with the worked steps.
-- A parent flips it (Settings → Homework help, or by telling Hana); lib/teaching.ts reads it.
ALTER TABLE household_members ADD COLUMN tutor_direct boolean NOT NULL DEFAULT false;
