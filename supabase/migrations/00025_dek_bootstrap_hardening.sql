-- 00025_dek_bootstrap_hardening.sql
-- Harden the `mbe_ems_dek` Vault bootstrap with explicit GUC opt-in (#107).
--
-- ── Why this migration exists ────────────────────────────────────────────
--
-- Migration 00018 (#101) bootstraps the OpenEMS data-encryption key (DEK)
-- into Supabase Vault. Its current logic (lines 120-148) silently falls
-- back to a random `gen_random_bytes(32)` DEK when the operator forgets to
-- pass `-v app.ems_dek_bootstrap=<value>` to `psql`. That is convenient
-- for local dev but catastrophic in production: ciphertexts written under
-- the ephemeral key become unrecoverable on the next migration replay,
-- and the only signal is a `RAISE WARNING` in the logs.
--
-- This migration installs a hardened bootstrap that REFUSES to silently
-- generate a DEK in production. The 3-branch decision tree below requires
-- one of two explicit opt-ins:
--
--   (a) `app.ems_dek_bootstrap` GUC set    → use it (production path)
--   (b) `app.allow_dev_dek = '1'` GUC set  → generate random + WARNING
--   (c) neither                            → RAISE EXCEPTION (fail loud)
--
-- ── Why a NEW migration, not an amendment to 00018 ───────────────────────
--
-- 00018 already ran against the cloud dev Supabase with the random-DEK
-- fallback. The generated DEK was captured out-of-band into 1Password (see
-- the `mbe_ems_dek` cloud-bootstrap runbook below). Re-running 00018 with a
-- different DEK would re-encrypt every ciphertext under a new key and brick
-- existing rows. The fix MUST be forward-only and idempotent against the
-- existing Vault row.
--
-- Idempotency invariant: this migration's first action is the same
-- `IF v_existing > 0 THEN RETURN; END IF;` early-return as 00018:125-129
-- copied verbatim. If the cloud row is present (it is), this migration is
-- a true no-op. The harder bootstrap kicks in only on fresh databases.
--
-- ── How `app.allow_dev_dek` gets injected for local dev ──────────────────
--
-- `setup.sh` (local mode) runs the following BEFORE `supabase db reset`:
--
--     psql "<local-db-url>" -c "ALTER DATABASE postgres SET app.allow_dev_dek = '1';"
--
-- `ALTER DATABASE ... SET` makes the GUC a session-default for every
-- subsequent connection on the local DB, including the migration runner
-- spawned by `supabase db reset`. The GUC then satisfies branch (b).
--
-- We deliberately do NOT inject the GUC via `supabase/config.toml [db.seed]`:
-- that block accepts only `enabled` and `sql_paths` keys (verified against
-- the current Supabase CLI). It does not run arbitrary SQL on the
-- migration-runner connection and so cannot set GUCs.
--
-- ── Operator runbook ─────────────────────────────────────────────────────
--
-- For cloud bootstrap procedure (DEK generation, 1Password capture,
-- recovery flow), see:
--   mbe-docs/docs/operational-runbooks/dek-bootstrap.md
--
-- ── References ───────────────────────────────────────────────────────────
--
-- Ticket: https://github.com/energy-iot/metering-billing-engine/issues/107
-- Predecessor: supabase/migrations/00018_openems_backend_per_microgrid.sql
-- (lines 120-148 — the original bootstrap this migration replaces in spirit
-- but never overwrites in the database).

DO $$
DECLARE
  v_existing INT;
  v_bootstrap TEXT;
  v_allow_dev TEXT;
BEGIN
  -- ── Idempotency guard (verbatim from 00018:125-129) ─────────────────────
  -- If the Vault row already exists, this migration is a no-op. This protects
  -- the cloud DEK (already bootstrapped) from being replaced.
  SELECT COUNT(*) INTO v_existing FROM vault.secrets WHERE name = 'mbe_ems_dek';
  IF v_existing > 0 THEN
    -- Already bootstrapped; nothing to do.
    RETURN;
  END IF;

  -- ── Branch (a): operator-supplied DEK via GUC ───────────────────────────
  v_bootstrap := current_setting('app.ems_dek_bootstrap', true);
  IF v_bootstrap IS NOT NULL AND length(btrim(v_bootstrap)) > 0 THEN
    PERFORM vault.create_secret(
      v_bootstrap,
      'mbe_ems_dek',
      'MBE OpenEMS envelope-encryption data-encryption key (DEK). See 00018 header for rotation recipe; see mbe-docs/docs/operational-runbooks/dek-bootstrap.md for cloud bootstrap.'
    );
    RETURN;
  END IF;

  -- ── Branch (b): explicit dev opt-in via GUC ─────────────────────────────
  v_allow_dev := current_setting('app.allow_dev_dek', true);
  IF v_allow_dev = '1' THEN
    v_bootstrap := encode(gen_random_bytes(32), 'base64');
    RAISE WARNING
      'mbe_ems_dek bootstrapped with an auto-generated dev DEK (app.allow_dev_dek=1). For production, run with `psql -v app.ems_dek_bootstrap=$(openssl rand -base64 32)` instead.';
    PERFORM vault.create_secret(
      v_bootstrap,
      'mbe_ems_dek',
      'MBE OpenEMS envelope-encryption data-encryption key (DEK). See 00018 header for rotation recipe; see mbe-docs/docs/operational-runbooks/dek-bootstrap.md for cloud bootstrap.'
    );
    RETURN;
  END IF;

  -- ── Branch (c): refuse to silently fabricate a DEK ──────────────────────
  RAISE EXCEPTION
    'DEK bootstrap required. Pass -v app.ems_dek_bootstrap=<base64> for production, or -v app.allow_dev_dek=1 for local dev. See mbe-docs/docs/operational-runbooks/dek-bootstrap.md.'
    USING ERRCODE = '55000';
END;
$$;
