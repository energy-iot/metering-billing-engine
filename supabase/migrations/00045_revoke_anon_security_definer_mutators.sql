-- 00045_revoke_anon_security_definer_mutators.sql
-- B1 (#268): Lock down the 3 anon-reachable SECURITY DEFINER mutators
-- exposed by the Supabase linter `anon_security_definer_function_executable`.
--
-- Why explicit REVOKE FROM anon (not just FROM PUBLIC):
-- 00016 line 39-44 does `ALTER DEFAULT PRIVILEGES … GRANT ALL ON ROUTINES
-- TO anon, authenticated, service_role`. This auto-grants EXECUTE-to-anon
-- on every function created after 00016. REVOKE FROM PUBLIC alone does NOT
-- undo that grant (anon is a specific role, not a PUBLIC member).
-- The root-cause fix to 00016 is #270 (B2); this ticket is the narrow,
-- urgent surface-level lock-down for the 3 mutators with the highest blast
-- radius (one of which — fn_apply_payment_event — has no body-side
-- auth.uid() guard, so the anon-reachable surface is a TRUE exposure).
--
-- Signatures are fully-qualified because PostgreSQL function grants are
-- keyed by (name, argument-type-list) — overloads are independent grant
-- targets. Get these wrong and the REVOKE silently no-ops.

-- 1. fn_apply_payment_event (7-arg sig from 00041)
REVOKE EXECUTE ON FUNCTION public.fn_apply_payment_event(
  UUID,
  public.billing_line_item_payment_status,
  TEXT,
  UUID,
  JSONB,
  TEXT,
  TEXT
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_apply_payment_event(
  UUID,
  public.billing_line_item_payment_status,
  TEXT,
  UUID,
  JSONB,
  TEXT,
  TEXT
) TO authenticated, service_role;

-- 2. fn_change_user_role (3-arg sig from 00013)
REVOKE EXECUTE ON FUNCTION public.fn_change_user_role(
  UUID,
  public.user_role,
  UUID
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_change_user_role(
  UUID,
  public.user_role,
  UUID
) TO authenticated, service_role;

-- 3. fn_finalize_user_invitation (6-arg sig from 00013)
REVOKE EXECUTE ON FUNCTION public.fn_finalize_user_invitation(
  UUID,
  TEXT,
  TEXT,
  TEXT,
  public.user_role,
  UUID
) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fn_finalize_user_invitation(
  UUID,
  TEXT,
  TEXT,
  TEXT,
  public.user_role,
  UUID
) TO authenticated, service_role;
