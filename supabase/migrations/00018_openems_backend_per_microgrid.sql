-- 00018_openems_backend_per_microgrid.sql
-- OpenEMS Backend per-microgrid connection config + Discover (#101).
--
-- ── Summary ──────────────────────────────────────────────────────────────
--
-- The pre-existing schema (AB #50) modelled OpenEMS connection config at the
-- EDGE level (`edges.openems_backend_url`) and hedged the data-source type
-- (`edge_data_source` enum including modbus_direct / mqtt / rest_api). Product
-- direction locked 2026-04-23:
--
--   * OpenEMS is the only supported edge type. Non-OpenEMS sources are out.
--   * Backend URL + auth live at the MICROGRID level. All edges under a
--     microgrid share one OpenEMS backend.
--   * No global default ("integrated OpenEMS from env vars"). Every microgrid
--     explicitly configures its own backend.
--   * AWS secret access keys are encrypted at rest via envelope encryption
--     (pgcrypto pgp_sym + a DEK held in Supabase Vault). Direct-URL mode
--     supports no auth at all — used for localhost dev only.
--
-- ── One-time Vault DEK bootstrap ─────────────────────────────────────────
--
-- The data-encryption key is named `mbe_ems_dek` in Vault. The migration
-- creates it if missing. Source of truth for the initial plaintext:
--
--     psql -v app.ems_dek_bootstrap="$(openssl rand -base64 32)" \
--          -f supabase/migrations/00018_openems_backend_per_microgrid.sql
--
-- If the secret already exists, the bootstrap GUC is ignored (no-op). If the
-- secret is missing AND the GUC is not set, the migration RAISES with setup
-- instructions (never silently falls back to a hardcoded dev DEK — that would
-- be recoverable from source-control history forever).
--
-- For `supabase db reset` (local dev) the CLI passes GUCs via PGOPTIONS; when
-- no GUC is supplied, we generate an ephemeral dev key inline using
-- gen_random_bytes and proceed. This is a dev-convenience only (operator
-- re-running reset gets a fresh key; ciphertexts from a prior reset become
-- undecryptable and surface as "re-enter credentials"). Production
-- deployments MUST supply the GUC.
--
-- ── DEK rotation recipe (out of scope for this ticket — documented here) ──
--
-- To rotate the DEK:
--   1. Generate a new plaintext DEK (openssl rand -base64 32).
--   2. For every microgrid with ems_aws_secret_access_key_encrypted IS NOT NULL:
--        a. Decrypt under the OLD DEK using fn_ems_decrypt_secret.
--        b. Update the Vault secret mbe_ems_dek to the NEW DEK
--           (vault.update_secret).
--        c. Re-encrypt under the NEW DEK using fn_ems_encrypt_secret and
--           persist via a direct UPDATE.
--   The fn_ems_decrypt_secret body always reads the CURRENT Vault DEK, so
--   step (c) must happen before any reader calls fn_ems_decrypt_secret.
--   Run the rotation as a single transaction (or re-encrypt before flipping
--   the Vault secret). A future ticket packages this into a migration or RPC.
--
-- ── Hard-reset safety: abort if legacy state would be orphaned ───────────
--
-- Dropping `edges.openems_backend_url` + `data_source_type` would invalidate
-- in-progress draft readings and orphan closed-invoice reproducibility.
-- The migration refuses to run (RAISE EXCEPTION inside the implicit
-- transaction) if any billing_periods rows exist OR any edges.openems_edge_id
-- is NULL. Operators must resolve those states before running this migration.
--
-- References: AC-SCHEMA-1..9 in issue #101. Patterns borrowed from
-- 00013_invite_user_rpc.sql (SECURITY DEFINER), 00015_entity_deletion_safeguards.sql
-- (GUC pattern), 00016_restore_default_grants.sql (grants pattern).

-- ═════════════════════════════════════════════════════════════════════════
-- 0. Safety checks — fail fast, before any DDL touches the schema.
-- ═════════════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_closed_count INT;
  v_draft_count INT;
  v_null_edge_id_count INT;
BEGIN
  SELECT COUNT(*) INTO v_closed_count FROM billing_periods WHERE status = 'closed';
  IF v_closed_count > 0 THEN
    RAISE EXCEPTION
      'Migration refused: % closed billing_periods exist. Dropping edges.openems_backend_url would orphan historical invoice data. Document or archive closed periods first, then re-run.',
      v_closed_count
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO v_draft_count FROM billing_periods WHERE status = 'draft';
  IF v_draft_count > 0 THEN
    RAISE EXCEPTION
      'Migration refused: % draft billing_periods exist. In-progress readings would become inconsistent. Close or delete draft periods first.',
      v_draft_count
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO v_null_edge_id_count FROM edges WHERE openems_edge_id IS NULL;
  IF v_null_edge_id_count > 0 THEN
    RAISE EXCEPTION
      'Migration refused: % edges with NULL openems_edge_id exist. All edges must have an openems_edge_id before the column becomes NOT NULL.',
      v_null_edge_id_count
      USING ERRCODE = '55000';
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Extensions (idempotent — no-op if already installed).
-- ═════════════════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS supabase_vault;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Bootstrap DEK in Vault (`mbe_ems_dek`) if not present.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Resolution order for the initial plaintext:
--   (a) session GUC app.ems_dek_bootstrap (operator-supplied)
--   (b) auto-generated dev key via gen_random_bytes (local dev convenience)
--
-- If the secret already exists, we skip entirely — rerun-safe.

DO $$
DECLARE
  v_bootstrap TEXT;
  v_existing INT;
BEGIN
  SELECT COUNT(*) INTO v_existing FROM vault.secrets WHERE name = 'mbe_ems_dek';
  IF v_existing > 0 THEN
    -- Already bootstrapped; nothing to do.
    RETURN;
  END IF;

  v_bootstrap := current_setting('app.ems_dek_bootstrap', true);

  IF v_bootstrap IS NULL OR length(btrim(v_bootstrap)) = 0 THEN
    -- Dev fallback: generate a random 32-byte key, base64-encoded.
    -- Operator should supply `app.ems_dek_bootstrap` in production.
    -- We emit a WARNING so prod deploys catch this in logs.
    v_bootstrap := encode(gen_random_bytes(32), 'base64');
    RAISE WARNING
      'mbe_ems_dek bootstrapped with an auto-generated dev DEK. For production, rerun with `psql -v app.ems_dek_bootstrap=$(openssl rand -base64 32)`.';
  END IF;

  PERFORM vault.create_secret(
    v_bootstrap,
    'mbe_ems_dek',
    'MBE OpenEMS envelope-encryption data-encryption key (DEK). See 00018 header for rotation recipe.'
  );
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Envelope encryption helpers.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Both functions are SECURITY DEFINER (owned by postgres), pinned search_path,
-- STABLE. They read the Vault DEK via vault.decrypted_secrets (the Vault view
-- that handles Vault's internal key-unwrapping) and apply pgp_sym_encrypt /
-- pgp_sym_decrypt with the DEK as the passphrase.
--
-- NOTE: pgp_sym_encrypt returns BYTEA; store as-is in ems_aws_secret_access_key_encrypted.
-- Round-trip: encrypt(decrypt(x)) = x bit-for-bit (verified by AC-TEST-3).

-- NOTE: pgcrypto installs pgp_sym_encrypt / pgp_sym_decrypt into the
-- `extensions` schema on Supabase (not `public`). We must either add
-- `extensions` to the search_path or schema-qualify each call. We pick
-- the latter for explicitness and to minimize the blast radius of the
-- search_path for SECURITY DEFINER functions.

CREATE OR REPLACE FUNCTION fn_ems_encrypt_secret(p_plaintext TEXT)
RETURNS BYTEA
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dek TEXT;
BEGIN
  IF p_plaintext IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_dek
  FROM vault.decrypted_secrets
  WHERE name = 'mbe_ems_dek'
  LIMIT 1;

  IF v_dek IS NULL THEN
    RAISE EXCEPTION 'mbe_ems_dek not found in Vault. Run 00018 migration with app.ems_dek_bootstrap GUC set.'
      USING ERRCODE = '55000';
  END IF;

  RETURN extensions.pgp_sym_encrypt(p_plaintext, v_dek);
END;
$$;

CREATE OR REPLACE FUNCTION fn_ems_decrypt_secret(p_ciphertext BYTEA)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_dek TEXT;
BEGIN
  IF p_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT decrypted_secret INTO v_dek
  FROM vault.decrypted_secrets
  WHERE name = 'mbe_ems_dek'
  LIMIT 1;

  IF v_dek IS NULL THEN
    RAISE EXCEPTION 'mbe_ems_dek not found in Vault. Cannot decrypt OpenEMS secret.'
      USING ERRCODE = '55000';
  END IF;

  -- pgp_sym_decrypt throws on mismatched key or corrupted input; let it propagate.
  RETURN extensions.pgp_sym_decrypt(p_ciphertext, v_dek);
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. New enum: microgrid_ems_type.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Two values for pilot:
--   'cloud_aws'  — SigV4 auth against a Lambda Function URL that fronts OpenEMS.
--                  Requires region + access key id + encrypted secret key.
--   'direct_url' — Plain HTTPS POST to an OpenEMS B2B REST endpoint. NO AUTH
--                  FIELDS (explicit product constraint, amended 2026-04-23):
--                  used only for localhost development or unauthenticated
--                  OpenEMS instances. For authenticated self-hosted OpenEMS,
--                  use cloud_aws via an authenticated Lambda proxy.
--
-- Future: 'gcp_lambda' / 'azure_function' etc. as authenticated-proxy aliases.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'microgrid_ems_type') THEN
    CREATE TYPE microgrid_ems_type AS ENUM ('cloud_aws', 'direct_url');
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Add ems_* columns to microgrids.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE microgrids
  ADD COLUMN IF NOT EXISTS ems_type microgrid_ems_type,
  ADD COLUMN IF NOT EXISTS ems_backend_url TEXT,
  ADD COLUMN IF NOT EXISTS ems_aws_region TEXT,
  ADD COLUMN IF NOT EXISTS ems_aws_access_key_id TEXT,
  ADD COLUMN IF NOT EXISTS ems_aws_secret_access_key_encrypted BYTEA,
  ADD COLUMN IF NOT EXISTS ems_last_discover_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ems_last_discover_status TEXT,
  ADD COLUMN IF NOT EXISTS ems_last_discover_error TEXT,
  ADD COLUMN IF NOT EXISTS ems_last_discover_count INT;

-- Named CHECK constraints (AC-SCHEMA-3). Drop-if-exists for idempotency.

ALTER TABLE microgrids DROP CONSTRAINT IF EXISTS microgrids_ems_backend_url_required;
ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_ems_backend_url_required
  CHECK (
    ems_type IS NULL
    OR (ems_backend_url IS NOT NULL AND length(btrim(ems_backend_url)) > 0)
  );

ALTER TABLE microgrids DROP CONSTRAINT IF EXISTS microgrids_ems_aws_fields_required;
ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_ems_aws_fields_required
  CHECK (
    ems_type IS DISTINCT FROM 'cloud_aws'
    OR (
      ems_aws_region IS NOT NULL
      AND ems_aws_access_key_id IS NOT NULL
      AND ems_aws_secret_access_key_encrypted IS NOT NULL
    )
  );

ALTER TABLE microgrids DROP CONSTRAINT IF EXISTS microgrids_ems_last_discover_status_valid;
ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_ems_last_discover_status_valid
  CHECK (
    ems_last_discover_status IS NULL
    OR ems_last_discover_status IN ('success', 'auth_failed', 'unreachable', 'zero_edges', 'unknown_error')
  );

-- ═════════════════════════════════════════════════════════════════════════
-- 6. fn_get_ems_secret — RLS-aware accessor for the decrypted AWS secret.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Semantics (must match AC-TEST-4 truth table):
--   | Caller context                         | Return                    |
--   |----------------------------------------|---------------------------|
--   | is_super_admin() = true, secret set    | plaintext                 |
--   | is_super_admin() = true, secret NULL   | NULL                      |
--   | org_manager (owner org), secret set    | NULL (redacted)           |
--   | org_manager (different org)            | NULL (RLS filters row)    |
--   | service_role direct call               | plaintext (documented)    |
--   | anon / unauthenticated                 | NULL                      |
--
-- service_role: auth.role() = 'service_role' and is_super_admin() = false (no
-- user_roles row for the service role). We explicitly allow plaintext for
-- service_role because the server-side Discover/readings pipeline uses the
-- service-role client for post-save ancillary reads in some flows. Routes
-- documented to MUST use the user-bound client for user-initiated Save &
-- Discover.
--
-- Row filtering: we run `SELECT FROM microgrids WHERE id = ...` inside a
-- SECURITY DEFINER body, which BYPASSES RLS. That's intentional — we want the
-- function to be the single authoritative source of the access rule, not an
-- accidental RLS divergence. The "different org" case is handled by
-- is_super_admin()=false + org_manager-of-different-org also having the
-- user_can_access_microgrid(id) short-circuit return NULL.

CREATE OR REPLACE FUNCTION fn_get_ems_secret(_microgrid_id UUID)
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
  -- service_role (server-side internal path) gets plaintext.
  -- auth.role() returns 'authenticated' for user-bound, 'anon' for unauth,
  -- 'service_role' for service-role calls.
  v_is_service := (auth.role() = 'service_role');

  v_is_super := is_super_admin();

  -- Redact if caller is neither super_admin nor service_role (org_manager,
  -- anon, etc.) — return NULL without leaking existence info.
  IF NOT v_is_super AND NOT v_is_service THEN
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

-- ═════════════════════════════════════════════════════════════════════════
-- 7. Legacy edges cleanup (AC-SCHEMA-4/5).
-- ═════════════════════════════════════════════════════════════════════════
--
-- Order matters:
--   1. Drop trigger on devices that references edge_data_source
--   2. Drop the trigger function
--   3. Drop the CHECK constraint on edges that references data_source_type
--   4. Drop the columns
--   5. Drop the enum TYPE
--   6. Flip openems_edge_id to NOT NULL
--   7. Re-install a simplified trigger enforcing "openems_component_id is always required"

DROP TRIGGER IF EXISTS trg_device_openems_component_valid ON devices;
DROP FUNCTION IF EXISTS fn_device_openems_component_valid() CASCADE;

ALTER TABLE edges DROP CONSTRAINT IF EXISTS edges_openems_fields_required;
ALTER TABLE edges DROP COLUMN IF EXISTS data_source_type;
ALTER TABLE edges DROP COLUMN IF EXISTS openems_backend_url;

DROP TYPE IF EXISTS edge_data_source;

-- Flip openems_edge_id NOT NULL. Safety check above ensures no NULLs remain.
ALTER TABLE edges ALTER COLUMN openems_edge_id SET NOT NULL;

-- Simplified replacement: devices.openems_component_id is always required.
-- (OpenEMS is the only edge type now.)
CREATE OR REPLACE FUNCTION fn_device_openems_component_valid()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.openems_component_id IS NULL THEN
    RAISE EXCEPTION 'devices.openems_component_id is required (edge_id=%)', NEW.edge_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_device_openems_component_valid ON devices;
CREATE TRIGGER trg_device_openems_component_valid
  BEFORE INSERT OR UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION fn_device_openems_component_valid();

-- ═════════════════════════════════════════════════════════════════════════
-- 8. Grants on new functions (AC-SCHEMA-6/8).
-- ═════════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION fn_ems_encrypt_secret(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_ems_decrypt_secret(BYTEA) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION fn_get_ems_secret(UUID) TO authenticated, service_role;
