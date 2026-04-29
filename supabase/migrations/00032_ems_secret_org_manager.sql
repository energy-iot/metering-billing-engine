-- 00032_ems_secret_org_manager.sql
-- Widen fn_get_ems_secret to org_manager-of-microgrid's-parent-org (#200).
--
-- ── Summary ──────────────────────────────────────────────────────────────
--
-- The original definition (00018) gated decryption to super_admin /
-- service_role only. Operationally, an org_manager onboarding a household
-- needs inline device-discovery from within the Add-Household wizard, which
-- routes through `getMicrogridEmsConfig` → `fn_get_ems_secret`. Without
-- widening, the wizard's discovery path returns NULL → opaque backend
-- config error for the org_manager persona that motivates the surface.
--
-- This migration replaces the function body so org_managers who can access
-- the microgrid (via `user_can_access_microgrid`) also receive the
-- plaintext secret. The function signature is unchanged
-- (`fn_get_ems_secret(_microgrid_id UUID) RETURNS TEXT`).
--
-- ── New truth table (supersedes the 00018:297-305 comment semantically;
--    the 00018 comment is left intact for historical accuracy) ──────────
--
--   | Caller context                                              | Return     |
--   |-------------------------------------------------------------|------------|
--   | super_admin                                                 | plaintext  |
--   | super_admin, secret NULL                                    | NULL       |
--   | service_role                                                | plaintext  |
--   | org_manager (microgrid's parent org), secret set            | plaintext  |  <-- NEW
--   | org_manager (microgrid's parent org), secret NULL           | NULL       |
--   | org_manager (different org)                                 | NULL       |
--   | microgrid not found / hard-deleted                          | NULL       |
--   | anon / unauthenticated                                      | NULL       |
--
-- ── Probing-resistance ──────────────────────────────────────────────────
--
-- Gate-first preserves the original 00018 ordering. `user_can_access_microgrid`
-- returns false for non-existent microgrids (community → org_id resolves to
-- NULL → `user_can_access_org(NULL)` is false), so 'row missing' and 'no
-- permission' both return NULL with no timing leak.
--
-- `is_super_admin()` short-circuits inside `user_can_access_org` (per
-- 00002_rls.sql:65), so super_admins continue to receive plaintext via the
-- gate without an explicit `is_super_admin()` check in this body.
--
-- ── Signature & grants ──────────────────────────────────────────────────
--
-- Signature unchanged. `CREATE OR REPLACE` preserves existing privileges in
-- Postgres ≥ 14, but we re-issue GRANT EXECUTE TO authenticated, service_role
-- defensively to mirror the 00018 / 00020 / 00030 patterns.

CREATE OR REPLACE FUNCTION fn_get_ems_secret(_microgrid_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
BEGIN
  -- Permission gate. service_role bypasses for server-side internal paths
  -- (Discover/readings pipeline). user_can_access_microgrid short-circuits
  -- to true for super_admin and for org_managers scoped to the microgrid's
  -- parent org (via communities → org_id).
  IF NOT (auth.role() = 'service_role' OR user_can_access_microgrid(_microgrid_id)) THEN
    RETURN NULL;
  END IF;

  SELECT ems_aws_secret_access_key_encrypted INTO v_ciphertext
    FROM microgrids
    WHERE id = _microgrid_id
    LIMIT 1;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

-- Defensive re-grant. CREATE OR REPLACE preserves privileges, but mirroring
-- the pattern from 00018 / 00020 / 00030 keeps the grant explicit at the
-- migration boundary in case the function was dropped + recreated by a
-- future change.
GRANT EXECUTE ON FUNCTION fn_get_ems_secret(UUID)
  TO authenticated, service_role;
