-- Meals: cuisine is the country of origin; region is where in that country (or the regional style).
ALTER TABLE meals ADD COLUMN IF NOT EXISTS region text NOT NULL DEFAULT '';
