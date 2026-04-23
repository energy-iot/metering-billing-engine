-- 00014_user_directory_view.sql
-- UX5 (#79): VIEW joining auth.users, user_profiles, user_roles for
-- the Settings > Users listing.
--
-- Design tension: the view needs to read auth.users (which has RLS
-- enabled for Supabase-internal reasons and grants no policy to
-- `authenticated`). security_invoker=true would inherit that
-- restriction → zero rows. security_invoker=false (default) lets the
-- view run as owner (postgres) and bypasses RLS on all underlying
-- tables — which would expose auth.users fully to tenant code.
--
-- Resolution: use security_invoker=false so the view can read
-- auth.users, AND add an explicit WHERE filter that calls the
-- helper `user_can_see_user_profile(user_id)`. The helper is
-- SECURITY DEFINER and reads `auth.uid()` from the caller's JWT, so
-- it enforces the same visibility the RLS policy would — no super_admins
-- visible to org_managers, each org_manager sees only users in orgs
-- they manage, etc.
--
-- Columns:
--   user_id, email, email_confirmed_at, last_sign_in_at,
--   first_name, last_name, phone,
--   role, scope_type, scope_id

CREATE OR REPLACE VIEW user_directory AS
  SELECT
    au.id                   AS user_id,
    au.email,
    au.email_confirmed_at,
    au.last_sign_in_at,
    up.first_name,
    up.last_name,
    up.phone,
    ur.role,
    ur.scope_type,
    ur.scope_id
  FROM auth.users au
  LEFT JOIN user_profiles up ON up.user_id = au.id
  LEFT JOIN user_roles    ur ON ur.user_id = au.id
  WHERE user_can_see_user_profile(au.id);

GRANT SELECT ON user_directory TO authenticated, anon;
