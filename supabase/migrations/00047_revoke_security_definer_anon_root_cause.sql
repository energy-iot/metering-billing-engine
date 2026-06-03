-- 00047_revoke_security_definer_anon_root_cause.sql
-- B2 (#270): Root-cause fix for the Supabase linter `anon_security_definer_function_executable`
-- and `authenticated_security_definer_function_executable` warnings (~14 of ~22 total cleared by
-- this migration alone; #268 cleared the other 3 high-blast-radius mutators).
--
-- See CLAUDE.md § "Migration conventions — SECURITY DEFINER grants" (added in this PR) for the
-- ongoing convention this migration codifies.

-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Root cause: narrow 00016 ALTER DEFAULT PRIVILEGES for ROUTINES
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 00016 set `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON ROUTINES TO anon, authenticated,
-- service_role`, which auto-grants EXECUTE-to-anon on every function created after.
-- That broke the assumption baked into every subsequent migration's `REVOKE EXECUTE … FROM
-- PUBLIC` pattern — anon is a specific role, not a PUBLIC member.
--
-- This REVOKE narrows the future-grant going forward; existing function grants are unaffected
-- (handled by explicit REVOKE blocks below).
--
-- service_role retained: trigger / admin / migration paths legitimately need it. RLS still
-- gates table access, so service_role having ROUTINES execute is no looser than the explicit
-- `GRANT ... TO service_role` blocks already present in most migrations.

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  REVOKE EXECUTE ON ROUTINES FROM anon, authenticated;

-- ═══════════════════════════════════════════════════════════════════════════
-- 2. REVOKE EXECUTE on the remaining 10 SECURITY DEFINER fns
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pattern: REVOKE FROM PUBLIC, anon (and authenticated for the trigger fn) +
-- re-issue GRANT EXECUTE to the intended roles.

-- ── 2a. Secret-handling (4 fns) ─────────────────────────────────────────────

REVOKE EXECUTE ON FUNCTION public.fn_ems_encrypt_secret(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ems_encrypt_secret(TEXT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fn_ems_decrypt_secret(BYTEA) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_ems_decrypt_secret(BYTEA) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fn_get_ems_secret(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_ems_secret(UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.fn_get_community_payment_secret(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_get_community_payment_secret(UUID) TO authenticated, service_role;

-- ── 2b. RLS helpers (5 fns) ─────────────────────────────────────────────────
--
-- These are called from RLS USING/WITH CHECK clauses on every authenticated query.
-- authenticated MUST retain EXECUTE — RLS evaluation runs as the querying user, which
-- is `authenticated` for normal logged-in users. anon has nothing to evaluate (no
-- RLS policies grant anon access to the gated tables), so REVOKE from anon is safe.

REVOKE EXECUTE ON FUNCTION public.is_super_admin() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_super_admin() TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_can_access_org(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_can_access_org(UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_can_access_community(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_can_access_community(UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_can_access_microgrid(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_can_access_microgrid(UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.user_can_see_user_profile(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.user_can_see_user_profile(UUID) TO authenticated, service_role;

-- ── 2c. Customerapp flag (1 fn) ─────────────────────────────────────────────
--
-- Fixes the gap left by my own Wave D #251 — #270's introduction of customerapp_enabled_for_org
-- did `REVOKE EXECUTE FROM PUBLIC` which (as documented above) does NOT cover the anon-via-
-- default-privileges grant. Re-issue with the correct REVOKE clause now.

REVOKE EXECUTE ON FUNCTION public.customerapp_enabled_for_org(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.customerapp_enabled_for_org(UUID) TO authenticated, service_role;

-- ── 2d. Trigger function (1 fn) ─────────────────────────────────────────────
--
-- fn_create_profile_on_auth_user is invoked by an AFTER INSERT trigger on auth.users.
-- Triggers fire with the function-owner's privileges (postgres) regardless of EXECUTE
-- grants on the function. So REVOKE EXECUTE from authenticated is safe — the trigger
-- still fires. The REVOKE only prevents anon/authenticated PostgREST RPC calls.

REVOKE EXECUTE ON FUNCTION public.fn_create_profile_on_auth_user() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_profile_on_auth_user() TO service_role;
