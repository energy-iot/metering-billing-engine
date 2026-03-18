-- Seed: Watt Works Foundation org
INSERT INTO organizations (id, name) VALUES
  ('a0000000-0000-0000-0000-000000000001', 'Watt Works Foundation');

-- Seed: Kisakye microgrid
INSERT INTO microgrids (id, org_id, name, location, currency) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Kisakye', 'Kisakye, Uganda', 'UGX');

-- Seed: Rate schedule for Kisakye
INSERT INTO rate_schedules (microgrid_id, tiers, service_charge, tax_rate) VALUES
  ('b0000000-0000-0000-0000-000000000001',
   '[{"label": "1st Tier", "min_kwh": 1, "max_kwh": 15, "rate_per_kwh": 250.0}, {"label": "2nd Tier", "min_kwh": 16, "max_kwh": 80, "rate_per_kwh": 756.2}, {"label": "3rd Tier", "min_kwh": 81, "max_kwh": 150, "rate_per_kwh": 412.0}, {"label": "4th Tier", "min_kwh": 151, "max_kwh": null, "rate_per_kwh": 756.2}]',
   5320, 0.18);

-- Tenants are managed through the app UI — not seeded here.
-- Real customer data (names, phone numbers) should never be in migrations.
