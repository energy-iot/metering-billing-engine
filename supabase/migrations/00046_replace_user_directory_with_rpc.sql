-- 00046_replace_user_directory_with_rpc.sql
-- A (#269): Replace public.user_directory view with fn_list_visible_users RPC
-- to clear two CRITICAL linter ERRORs: auth_users_exposed + security_definer_view.
--
-- Path 2a chosen (drop view + refactor consumers; ref Alejandro msg 599658247).
-- The view's FK-join shorthand surface (`user_directory!entered_by_user_id(...)`)
-- was used by 1 of 5 consumers; that consumer is restructured to a two-step
-- fetch in the same PR. All other consumers do simple .from('user_directory')
-- → .rpc('fn_list_visible_users') swaps.
--
-- Why not just flip the view to security_invoker=true (the literal "Path 2c"):
--   auth.users RLS denies authenticated by design (per 00014 file comment), so
--   a security_invoker view over auth.users returns 0 rows for everyone.
--
-- Why not keep view + add RPC (the "Path 2b" hybrid): client-side joins +
-- view-column-shrink + duplicated visibility predicate = real tech debt
-- per architect-lane assessment (msg 599654301).

-- ── 1. Drop the view ─────────────────────────────────────────────────────────
--
-- CASCADE removes the foreign-key-relationship hints that PostgREST exposed
-- as FK-join shorthand. Any consumer still depending on `.from('user_directory')`
-- after this migration will fail at runtime; codegen (database.gen.ts) is the
-- safety net — `npm run db:types` will drop the View entry and the affected
-- `referencedRelation: "user_directory"` references in the codegen output.

DROP VIEW IF EXISTS public.user_directory CASCADE;

-- ── 2. Create the replacement RPC ────────────────────────────────────────────
--
-- Signature mirrors the columns the view exposed (user_id, email,
-- email_confirmed_at, last_sign_in_at, first_name, last_name, phone, role,
-- scope_type, scope_id). _target_user_ids is the single parameter — NULL
-- lists all visible users; non-NULL filters to those ids. Replaces both the
-- "list" pattern (settings/users page) and "single-user lookup" pattern
-- (resend-invite route, PDF route) with one function.
--
-- Visibility predicate is `user_can_see_user_profile(au.id)` — identical to
-- the gate that today's view uses in its WHERE clause. The helper itself
-- is SECURITY DEFINER and reads `auth.uid()` from the caller's JWT, so the
-- predicate enforces the same visibility rules:
--   - caller is target
--   - caller is super_admin
--   - caller shares an org-scoped manager role with the target
--
-- LANGUAGE sql + STABLE: predicate is pure-read; no PL/pgSQL needed. The
-- `(_target_user_ids IS NULL OR au.id = ANY(_target_user_ids))` clause
-- elegantly handles both list-all and filter-by-set patterns in one query.
--
-- Note on `auth.users.email` type: the underlying column in `auth.users` is
-- `character varying`, not `text`. The explicit `::TEXT` cast in the SELECT
-- keeps the RPC's return-type column stable across Postgres versions /
-- Supabase upgrades.

CREATE OR REPLACE FUNCTION public.fn_list_visible_users(
  _target_user_ids UUID[] DEFAULT NULL
)
RETURNS TABLE (
  user_id            UUID,
  email              TEXT,
  email_confirmed_at TIMESTAMPTZ,
  last_sign_in_at    TIMESTAMPTZ,
  first_name         TEXT,
  last_name          TEXT,
  phone              TEXT,
  role               public.user_role,
  scope_type         public.role_scope_type,
  scope_id           UUID
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    au.id                        AS user_id,
    au.email::TEXT               AS email,
    au.email_confirmed_at,
    au.last_sign_in_at,
    up.first_name,
    up.last_name,
    up.phone,
    ur.role,
    ur.scope_type,
    ur.scope_id
  FROM auth.users au
  LEFT JOIN public.user_profiles up ON up.user_id = au.id
  LEFT JOIN public.user_roles    ur ON ur.user_id = au.id
  WHERE user_can_see_user_profile(au.id)
    AND (_target_user_ids IS NULL OR au.id = ANY(_target_user_ids));
$$;

-- ── 3. Grants (follows B2 convention preemptively) ───────────────────────────

REVOKE EXECUTE ON FUNCTION public.fn_list_visible_users(UUID[])
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_list_visible_users(UUID[])
  TO authenticated, service_role;
