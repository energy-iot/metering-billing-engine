-- 00012_user_profiles.sql
-- UX5 (#79): user_profiles table, reusable updated_at trigger fn, RLS helper,
-- and RLS policies.
--
-- Design notes:
--   * `user_profiles` holds first_name / last_name / phone for a Supabase
--     auth.users row. auth.users only has `email`; this is the only
--     home for human identity in MBE.
--   * `fn_set_updated_at()` is the first reusable `updated_at` trigger fn
--     for MBE. Future tables that gain an `updated_at` column reuse it
--     rather than copy-pasting a one-off.
--   * The RLS helper `user_can_see_user_profile(_target)` mirrors the
--     shape of `is_super_admin()` / `user_can_access_org()` from
--     00002_rls.sql:42-90: SECURITY DEFINER, STABLE, pinned search_path.
--   * Org_manager visibility EXPLICITLY excludes super_admins (scope_id
--     IS NULL rows) per PM decision — Aaron does not see Alejandro in the
--     user list. Escalation is out-of-band (Zulip / email).
--
-- RLS policies:
--   * SELECT: helper-based visibility.
--   * UPDATE: self or super_admin. Org_managers cannot edit OTHERS'
--     profiles (they can invite new users and revoke; they cannot rewrite
--     names).
--   * INSERT: WITH CHECK (FALSE). Only the SECURITY INVOKER RPC
--     `fn_finalize_user_invitation` writes here (via its SQL body while
--     running as the caller). Postgres evaluates WITH CHECK on INSERT;
--     USING (FALSE) would be semantically inert for inserts.

-- ── Reusable updated_at trigger function ─────────────────────────────────

-- Sets NEW.updated_at = now() on BEFORE UPDATE.
-- Pinned search_path. Future tables with `updated_at` reuse this.
CREATE OR REPLACE FUNCTION fn_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ── user_profiles table ──────────────────────────────────────────────────

-- One profile row per auth.users row. ON DELETE CASCADE cleans the profile
-- if the auth.users row is purged externally (Supabase admin console or a
-- manual cleanup). MBE's own soft-delete flow clears `user_roles` only and
-- leaves auth.users + user_profiles intact, so the cascade is inert in the
-- normal flow — but we keep it so external purges don't leave orphans.
CREATE TABLE user_profiles (
  user_id    UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  first_name TEXT,
  last_name  TEXT,
  phone      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Bump updated_at on every UPDATE.
CREATE TRIGGER trg_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION fn_set_updated_at();

-- ── RLS helper: user_can_see_user_profile ────────────────────────────────

-- True iff the caller can see the profile of `_target_user_id`:
--   1. Self (always).
--   2. Super admin (sees everyone).
--   3. Org manager: there exists a user_roles row for the target that is
--      scoped to an org the caller can access. REQUIRES scope_id IS NOT NULL
--      so super_admins (scope_id IS NULL) remain invisible to org_managers.
--
-- SECURITY DEFINER bypasses RLS on user_roles during the subquery — avoids
-- recursion and lets the helper do its job in one hop.
CREATE OR REPLACE FUNCTION user_can_see_user_profile(_target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    auth.uid() = _target_user_id
    OR is_super_admin()
    OR EXISTS (
      SELECT 1
      FROM user_roles ur
      WHERE ur.user_id = _target_user_id
        AND ur.scope_type = 'org'
        AND ur.scope_id IS NOT NULL
        AND user_can_access_org(ur.scope_id)
    );
$$;

-- ── Policies ─────────────────────────────────────────────────────────────

-- SELECT: helper-gated visibility (mirror of the AB pattern — one helper
-- call per USING clause, no inline JOINs).
CREATE POLICY "Authorized users can read user_profiles"
  ON user_profiles FOR SELECT
  USING (user_can_see_user_profile(user_id));

-- UPDATE: caller may edit own row, or any row if super_admin.
-- Org_managers CANNOT edit another user's profile. Route-level code is
-- expected to convert a 0-row update (empty set from RLS filter) into a 403.
CREATE POLICY "Users edit own profile or super_admin edits any"
  ON user_profiles FOR UPDATE
  USING (auth.uid() = user_id OR is_super_admin())
  WITH CHECK (auth.uid() = user_id OR is_super_admin());

-- INSERT: no one inserts directly. `fn_finalize_user_invitation` is the
-- single legitimate writer. We use WITH CHECK (FALSE) — not USING (FALSE) —
-- because Postgres evaluates WITH CHECK (not USING) on INSERT rows.
CREATE POLICY "No direct user_profiles inserts"
  ON user_profiles FOR INSERT
  WITH CHECK (FALSE);

-- DELETE: no direct deletes. Cascade from auth.users handles external
-- cleanup. No DELETE policy = no one can delete via RLS.
