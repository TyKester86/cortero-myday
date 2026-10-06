-- Pricing (Oct 2026): two tiers, monthly or yearly, and a founding price for
-- the first 100 households on Family, locked for life (a Stripe subscription
-- keeps the price it started with; MyDay keeps offering it to a household
-- that already holds it).
--   Family     $12.99/mo  or $99/yr   (Founding 100: $9.99/mo or $79/yr)
--   Family+    $19.99/mo  or $149/yr
-- offered: shown on the Billing page (admin-made plans can still be assigned by hand).
ALTER TABLE billing_plans
  ADD COLUMN tier text NOT NULL DEFAULT 'family' CHECK (tier IN ('family', 'familyplus')),
  ADD COLUMN founding boolean NOT NULL DEFAULT false,
  ADD COLUMN offered boolean NOT NULL DEFAULT false,
  ADD COLUMN sort integer NOT NULL DEFAULT 0;

INSERT INTO billing_plans (code, name, price_cents, interval, tier, founding, offered, sort) VALUES
  ('founding-monthly',   'Family (founding)', 999,   'month', 'family',     true,  true, 1),
  ('founding-yearly',    'Family (founding)', 7900,  'year',  'family',     true,  true, 2),
  ('family-monthly',     'Family',            1299,  'month', 'family',     false, true, 3),
  ('family-yearly',      'Family',            9900,  'year',  'family',     false, true, 4),
  ('familyplus-monthly', 'Family+',           1999,  'month', 'familyplus', false, true, 5),
  ('familyplus-yearly',  'Family+',           14900, 'year',  'familyplus', false, true, 6)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents, interval = EXCLUDED.interval,
  tier = EXCLUDED.tier, founding = EXCLUDED.founding, offered = true, active = true, sort = EXCLUDED.sort;

-- New households start on Family (monthly); the old unpriced placeholder plan retires.
UPDATE billing_plans SET is_default = false WHERE is_default;
UPDATE billing_plans SET is_default = true WHERE code = 'family-monthly';
UPDATE households SET plan_id = (SELECT id FROM billing_plans WHERE code = 'family-monthly')
 WHERE plan_id IN (SELECT id FROM billing_plans WHERE code = 'household' AND price_cents IS NULL) OR plan_id IS NULL;
UPDATE billing_plans SET active = false WHERE code = 'household' AND price_cents IS NULL;
