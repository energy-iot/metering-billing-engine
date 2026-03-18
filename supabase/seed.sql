-- seed.sql — local dev only, runs after migrations on `supabase db reset`

CREATE OR REPLACE FUNCTION seed_create_user(
  user_email text,
  user_password text,
  user_id uuid DEFAULT 'a1111111-1111-1111-1111-111111111111'::uuid
) RETURNS uuid AS $$
DECLARE
  encrypted_pw text;
BEGIN
  encrypted_pw := extensions.crypt(user_password, extensions.gen_salt('bf'));
  INSERT INTO auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, last_sign_in_at,
    raw_app_meta_data, raw_user_meta_data,
    created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token
  ) VALUES (
    '00000000-0000-0000-0000-000000000000', user_id, 'authenticated', 'authenticated',
    user_email, encrypted_pw, now(), now(),
    '{"provider":"email","providers":["email"]}', '{}',
    now(), now(), '', '', '', ''
  );
  INSERT INTO auth.identities (
    id, user_id, provider_id, identity_data, provider,
    last_sign_in_at, created_at, updated_at
  ) VALUES (
    user_id, user_id, user_id::text,
    jsonb_build_object('sub', user_id::text, 'email', user_email),
    'email', now(), now(), now()
  );
  RETURN user_id;
END;
$$ LANGUAGE plpgsql;

SELECT seed_create_user('admin@eiot.energy', 'admin123');
INSERT INTO user_roles (user_id, role)
VALUES ('a1111111-1111-1111-1111-111111111111', 'system_admin');
DROP FUNCTION seed_create_user;
