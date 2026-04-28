-- 00030_payment_secret_org_manager.sql
-- Widen fn_get_community_payment_secret to org_manager-of-parent-org (#196).
--
-- ── Summary ──────────────────────────────────────────────────────────────
--
-- The original definition (00020) gated decryption to super_admin /
-- service_role only. Operationally, an org_manager owning a community in a
-- different org needs to configure and rotate that community's payment
-- provider without pinging a super_admin every time. This migration replaces
-- the function body so org_managers scoped to the community's parent org
-- also get the plaintext secret.
--
-- Authorization is delegated to `user_can_access_org` (00002_rls.sql:57-73),
-- which already short-circuits to true for super_admins (00002_rls.sql:65)
-- — there is no need to call `is_super_admin()` again in this body.
-- `service_role` bypass is preserved for cron / IPN handler call sites.
--
-- ── New truth table ──────────────────────────────────────────────────────
--
--   | Caller context                                              | Return     |
--   |-------------------------------------------------------------|------------|
--   | is_super_admin() = true, secret set                         | plaintext  |
--   | is_super_admin() = true, secret NULL                        | NULL       |
--   | service_role                                                | plaintext  |
--   | org_manager (community's parent org), secret set            | plaintext  |  <-- NEW
--   | org_manager (community's parent org), secret NULL           | NULL       |
--   | org_manager (different org)                                 | NULL       |
--   | community not found / hard-deleted                          | NULL       |
--   | anon / unauthenticated                                      | NULL       |
--
-- ── Probing-resistance ───────────────────────────────────────────────────
--
-- The lookup-then-gate ordering preserves the property documented at
-- 00020:103-106: NULL is returned uniformly for "row missing" AND for
-- "no permission", so an unauthorized caller cannot probe for row existence
-- via timing or distinguishable return values.
--
-- ── Signature & grants ───────────────────────────────────────────────────
--
-- Signature unchanged: `fn_get_community_payment_secret(_community_id UUID)
-- RETURNS TEXT`. `CREATE OR REPLACE` preserves existing privileges in
-- Postgres ≥ 14, but we re-issue GRANT EXECUTE TO authenticated, service_role
-- defensively to mirror the 00018 / 00020 patterns.

CREATE OR REPLACE FUNCTION fn_get_community_payment_secret(_community_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_org_id UUID;
  v_ciphertext BYTEA;
BEGIN
  -- Lookup org_id + ciphertext in a single read.
  SELECT org_id, payment_provider_secret_encrypted
    INTO v_org_id, v_ciphertext
    FROM communities
    WHERE id = _community_id
    LIMIT 1;

  -- Row missing → NULL (uniform with redaction; non-authorized callers
  -- cannot probe for row existence).
  IF v_org_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Permission gate. user_can_access_org already short-circuits
  -- is_super_admin() → true (00002_rls.sql:65), so an explicit
  -- is_super_admin() check would be redundant. service_role bypass is
  -- preserved for the cron / IPN handler call sites.
  IF NOT (auth.role() = 'service_role' OR user_can_access_org(v_org_id)) THEN
    RETURN NULL;
  END IF;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

-- Defensive re-grant. CREATE OR REPLACE preserves privileges, but mirroring
-- the pattern from 00018 / 00020 keeps the grant explicit at the migration
-- boundary in case the function was dropped + recreated by a future change.
GRANT EXECUTE ON FUNCTION fn_get_community_payment_secret(UUID)
  TO authenticated, service_role;
