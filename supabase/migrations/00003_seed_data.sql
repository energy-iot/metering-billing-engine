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

-- Seed: 10 tenants (no meter assignments yet)
INSERT INTO tenants (microgrid_id, name, phone) VALUES
  ('b0000000-0000-0000-0000-000000000001', 'Ronald Babalanda', '774616353'),
  ('b0000000-0000-0000-0000-000000000001', 'Stephen Nganda', '704879156'),
  ('b0000000-0000-0000-0000-000000000001', 'Kisakye Farm House 3', '784760889'),
  ('b0000000-0000-0000-0000-000000000001', 'Derick Katwesige', '781380634'),
  ('b0000000-0000-0000-0000-000000000001', 'Robert Irumba', '703832192'),
  ('b0000000-0000-0000-0000-000000000001', 'Ntale Peter', '777379547'),
  ('b0000000-0000-0000-0000-000000000001', 'Wataba Samuel', '701482803'),
  ('b0000000-0000-0000-0000-000000000001', 'Jackie Nabisere', '78065708'),
  ('b0000000-0000-0000-0000-000000000001', 'Kisakye Farm House 2', '775622423'),
  ('b0000000-0000-0000-0000-000000000001', 'Kisakye Farm House', '774829993');
