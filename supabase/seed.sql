-- seed.sql — local dev only, runs after migrations on `supabase db reset`
-- Creates admin user for local development login

-- Create admin user in auth.users
-- Password hash is a pre-computed bcrypt of 'admin123' to avoid pgcrypto
-- dependency issues in the seed context.
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, last_sign_in_at,
  raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, email_change, email_change_token_new, recovery_token
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  'a1111111-1111-1111-1111-111111111111',
  'authenticated', 'authenticated',
  'admin@eiot.energy',
  '$2y$10$4bDaHdlixW.Y5evWx6qlu.trIo9vOAHTpLJrn2iObUG1rtdv9citG',
  now(), now(),
  '{"provider":"email","providers":["email"]}', '{}',
  now(), now(), '', '', '', ''
);

-- Create identity record for email auth
INSERT INTO auth.identities (
  id, user_id, provider_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
) VALUES (
  'a1111111-1111-1111-1111-111111111111',
  'a1111111-1111-1111-1111-111111111111',
  'a1111111-1111-1111-1111-111111111111',
  jsonb_build_object('sub', 'a1111111-1111-1111-1111-111111111111', 'email', 'admin@eiot.energy'),
  'email', now(), now(), now()
);

-- Assign system_admin role
INSERT INTO user_roles (user_id, role)
VALUES ('a1111111-1111-1111-1111-111111111111', 'system_admin');
