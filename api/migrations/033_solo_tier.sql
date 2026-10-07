-- Pricing (Oct 2026): a third tier for one grown-up.
--   Solo       $8.99/mo   or $69/yr    one adult, the full app
--   Family     $12.99/mo  or $99/yr    (Founding 100: $9.99/mo or $79/yr)
--   Family+    $19.99/mo  or $149/yr   unlimited Hana
-- Solo is offered to households with at most one grown-up (routes/billing.ts).
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'billing_plans'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%tier%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE billing_plans DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE billing_plans ADD CONSTRAINT billing_plans_tier_check CHECK (tier IN ('solo', 'family', 'familyplus'));

-- Solo first on the page.
UPDATE billing_plans SET sort = sort + 2 WHERE tier <> 'solo' AND sort > 0;
INSERT INTO billing_plans (code, name, price_cents, interval, tier, founding, offered, sort) VALUES
  ('solo-monthly', 'Solo', 899,  'month', 'solo', false, true, 1),
  ('solo-yearly',  'Solo', 6900, 'year',  'solo', false, true, 2)
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, price_cents = EXCLUDED.price_cents, interval = EXCLUDED.interval,
  tier = EXCLUDED.tier, founding = EXCLUDED.founding, offered = true, active = true, sort = EXCLUDED.sort;
