-- 00020_communities_payment_provider.sql
-- Payment-provider config on communities (#115).
--
-- ── Summary ──────────────────────────────────────────────────────────────
--
-- Adds provider-agnostic payment config to `communities`. A community operates
-- under one legal/payment relationship with one provider, so config lives at
-- the community level (not microgrid, not org).
--
-- Four columns, always written atomically by the (future, #P3) Save-&-test
-- route. The CHECK constraint enforces the invariant: "configuring the
-- provider is the ONLY path that sets these four fields, and it always sets
-- them together." A row with `payment_provider` set but `payment_last_configured_at`
-- NULL would mean credentials were persisted without a successful verify —
-- forbidden.
--
-- ── DEK reuse rationale ──────────────────────────────────────────────────
--
-- Reuses the existing `mbe_ems_dek` Vault secret + `fn_ems_encrypt_secret`
-- / `fn_ems_decrypt_secret` helpers from 00018. Rationale:
--   * Adding a sibling DEK (`mbe_payment_dek`) would double the Vault
--     bootstrap surface and complicate rotation without a compliance driver.
--   * The helper names are very slightly misleading now (used for non-EMS
--     data) — renaming to `fn_app_*` is a deferred cosmetic cleanup tracked
--     outside this ticket. Behaviour is identical.
--   * Future compliance-driven blast-radius separation (sibling DEK per secret
--     class) remains a clean migration at that time.
--
-- This migration adds exactly one new helper: `fn_get_community_payment_secret`,
-- mirroring `fn_get_ems_secret` semantics for the payment-config row.
--
-- ── Idempotency ──────────────────────────────────────────────────────────
--
-- All statements are guarded: `IF NOT EXISTS`, `DO $$...IF NOT EXISTS`, and
-- `DROP CONSTRAINT IF EXISTS` before `ADD CONSTRAINT`. Re-running this
-- migration is safe.
--
-- References: AC-SCHEMA-1..7 in issue #115. Patterns borrowed from
-- 00018_openems_backend_per_microgrid.sql (enum+bytea+helper shape) and
-- 00019_microgrids_known_edge_ids.sql (idempotent CHECK pattern).

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Enum: payment_provider_type.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Pilot ships with a single value ('pesapal'). Future providers (Stripe,
-- Flutterwave, M-Pesa) are additive via `ALTER TYPE payment_provider_type
-- ADD VALUE '<name>'` — no schema migration for the columns needed.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payment_provider_type') THEN
    CREATE TYPE payment_provider_type AS ENUM ('pesapal');
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Add payment_* columns to communities.
-- ═════════════════════════════════════════════════════════════════════════
--
-- All four columns are nullable — NULL ⇒ "not configured" for this community.
-- Shape of `payment_provider_config` is provider-specific and validated in
-- application code (Zod), not in the DB. Direct DB writes bypass that
-- validation; a future hardening ticket may add a JSONB CHECK via a validator
-- function. The invariant below still guarantees that whichever shape lands,
-- the accompanying encrypted secret and configured-at timestamp are present.

ALTER TABLE communities
  ADD COLUMN IF NOT EXISTS payment_provider payment_provider_type,
  ADD COLUMN IF NOT EXISTS payment_provider_config JSONB,
  ADD COLUMN IF NOT EXISTS payment_provider_secret_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS payment_last_configured_at TIMESTAMPTZ;

-- Named CHECK — drop-if-exists for idempotency.
ALTER TABLE communities DROP CONSTRAINT IF EXISTS communities_payment_fields_required;
ALTER TABLE communities
  ADD CONSTRAINT communities_payment_fields_required
  CHECK (
    payment_provider IS NULL
    OR (
      payment_provider_config IS NOT NULL
      AND payment_provider_secret_encrypted IS NOT NULL
      AND payment_last_configured_at IS NOT NULL
    )
  );

-- ═════════════════════════════════════════════════════════════════════════
-- 3. fn_get_community_payment_secret — RLS-aware accessor for the decrypted
--    payment-provider secret. Mirrors fn_get_ems_secret semantics.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Semantics truth table (matches AC-TEST-4 in issue #115):
--   | Caller context                          | Return                     |
--   |-----------------------------------------|----------------------------|
--   | is_super_admin() = true, secret set     | plaintext                  |
--   | is_super_admin() = true, secret NULL    | NULL                       |
--   | org_manager (owner org), secret set     | NULL (redacted)            |
--   | org_manager (different org)             | NULL                       |
--   | service_role                            | plaintext (documented)     |
--   | anon / unauthenticated                  | NULL                       |
--
-- The SELECT inside the SECURITY DEFINER body BYPASSES RLS. This is
-- intentional — the function is the single authoritative access rule.
-- Non-super_admin / non-service_role callers short-circuit to NULL before
-- any lookup, so they cannot probe for row existence.

CREATE OR REPLACE FUNCTION fn_get_community_payment_secret(_community_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
  v_is_super BOOLEAN;
  v_is_service BOOLEAN;
BEGIN
  v_is_service := (auth.role() = 'service_role');
  v_is_super := is_super_admin();

  IF NOT v_is_super AND NOT v_is_service THEN
    RETURN NULL;
  END IF;

  SELECT payment_provider_secret_encrypted INTO v_ciphertext
  FROM communities
  WHERE id = _community_id
  LIMIT 1;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Grants.
-- ═════════════════════════════════════════════════════════════════════════
--
-- `authenticated` + `service_role` only; `anon` is NOT granted (matches 00018).
-- Non-super_admin authenticated callers receive NULL (redacted) per the
-- truth table above — the grant lets them call the function, the body enforces
-- the redaction rule.

GRANT EXECUTE ON FUNCTION fn_get_community_payment_secret(UUID)
  TO authenticated, service_role;
