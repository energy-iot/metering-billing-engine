-- 00054_ems_basic_auth_credentials.sql
-- #327. Credentials for an authenticated self-hosted OpenEMS Backend.
--
-- `direct_url` shipped with no auth fields — a decision recorded in #101 and
-- restated in `src/lib/openems/index.ts`. An operator running OpenEMS Backend
-- with the REST/JSON-RPC API enabled gets an authenticated endpoint by
-- default, so the documented answer was "put an authenticated Lambda in front
-- and use cloud_aws". That is a coherent boundary and the wrong one for a
-- pilot: it asks a customer to do infrastructure work to use a feature that
-- already ships. Widened deliberately (#327).
--
-- ── Why no new `ems_type` value ──────────────────────────────────────────
--
-- These are OPTIONAL columns on the existing `direct_url` mode, not a third
-- connection type. `ALTER TYPE … ADD VALUE` cannot be undone: #316 added
-- `ems_operator` to `user_role` and #321 deleted the entire model the same
-- day, and the value is still in the type with nothing reading it. A mode
-- that is "direct_url, with credentials if present" leaves no residue if it
-- is ever withdrawn.
--
-- ── The guard enumeration below is the load-bearing part ─────────────────
--
-- `fn_microgrids_guard_ems_config` names its columns literally, in two
-- places: the `BEFORE UPDATE OF` statement filter and the `IS DISTINCT FROM`
-- value checks in the body. Both new columns go in BOTH. A guarded column
-- omitted from either is writable with no error and no warning.
--
-- Literal enumeration is mandated by CLAUDE.md because prefix matching would
-- absorb the `ems_last_discover_*` health columns, which must stay writable
-- for Discover on the user's own client. The cost of that correctness is that
-- additions are easy to forget; this is the first addition since 00052.
--
-- Note this is NOT justified by an exposure that exists today: the RLS policy
-- on `microgrids` and the guard's predicate currently admit the same people.
-- They are two separately-maintained expressions reaching the same org by
-- different routes —
--
--   policy  user_can_access_community(community_id)   (00031)
--   guard   user_can_access_microgrid(NEW.id)         (00053)
--
-- — and nothing ties them together. The guard is what would still be
-- enforcing if they diverge, which is exactly why a credential column belongs
-- inside it rather than outside.
--
-- Contents:
--   1. Two columns: username (plaintext) + password (DEK-encrypted BYTEA)
--   2. Guard function re-issued with both columns enumerated
--   3. Trigger re-issued with both columns in BEFORE UPDATE OF
--   4. fn_get_ems_basic_auth_password() — service-role-only read, mirroring
--      fn_get_ems_secret's post-00049 grants


-- ═══════════════════════════════════════════════════════════════════════════
-- 1. Columns
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Username is plaintext by design: it is an identifier, not a secret, and it
-- must be readable to render "configured as <user>" without a decrypt. It is
-- therefore added to MICROGRID_PUBLIC_COLUMNS in the same change.
--
-- Password is BYTEA holding pgp_sym_encrypt output, exactly like
-- ems_aws_secret_access_key_encrypted (00018). No new secret mechanism: the
-- same Vault DEK, the same fn_ems_encrypt_secret / fn_ems_decrypt_secret pair.
-- It stays OUT of MICROGRID_PUBLIC_COLUMNS.

ALTER TABLE public.microgrids
  ADD COLUMN IF NOT EXISTS ems_basic_auth_username TEXT,
  ADD COLUMN IF NOT EXISTS ems_basic_auth_password_encrypted BYTEA;

COMMENT ON COLUMN public.microgrids.ems_basic_auth_username IS
  'HTTP Basic username for direct_url mode (#327). Plaintext — an identifier, not a secret.';

COMMENT ON COLUMN public.microgrids.ems_basic_auth_password_encrypted IS
  'HTTP Basic password for direct_url mode (#327), pgp_sym_encrypt output under the Vault DEK. Read only via fn_get_ems_basic_auth_password (service_role).';


-- ═══════════════════════════════════════════════════════════════════════════
-- 2. Guard function — both new columns added to the value-level checks
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Body is 00053's verbatim except for the two added OR clauses. SECURITY
-- INVOKER, as it has been since 00052: the function fires as the caller and
-- reaches `user_can_access_microgrid`, which is SECURITY DEFINER and carries
-- its own rights.

CREATE OR REPLACE FUNCTION public.fn_microgrids_guard_ems_config()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF session_user IN ('postgres', 'supabase_admin') THEN
    RETURN NEW;
  END IF;

  IF auth.role() = 'service_role' THEN
    RETURN NEW;
  END IF;

  IF (NEW.ems_type                            IS DISTINCT FROM OLD.ems_type)
     OR (NEW.ems_backend_url                  IS DISTINCT FROM OLD.ems_backend_url)
     OR (NEW.ems_aws_region                   IS DISTINCT FROM OLD.ems_aws_region)
     OR (NEW.ems_aws_access_key_id            IS DISTINCT FROM OLD.ems_aws_access_key_id)
     OR (NEW.ems_aws_secret_access_key_encrypted
                                              IS DISTINCT FROM OLD.ems_aws_secret_access_key_encrypted)
     OR (NEW.ems_basic_auth_username          IS DISTINCT FROM OLD.ems_basic_auth_username)
     OR (NEW.ems_basic_auth_password_encrypted
                                              IS DISTINCT FROM OLD.ems_basic_auth_password_encrypted)
     OR (NEW.ems_known_edge_ids               IS DISTINCT FROM OLD.ems_known_edge_ids)
  THEN
    IF NOT user_can_access_microgrid(NEW.id) THEN
      RAISE EXCEPTION
        'You do not have permission to configure the OpenEMS connection for this microgrid.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- Same pattern as 00047 § 2d. The half that transfers is "regardless of
-- EXECUTE grants" — true of any trigger function. § 2d's other half, "fires
-- with the function-owner's privileges", is a SECURITY DEFINER property; this
-- function is SECURITY INVOKER and fires as the caller.
--
-- Statement order in this section — function, then trigger, then revoke — is
-- safe to change only while migrations apply as the function's owner: REVOKE …
-- FROM PUBLIC leaves owner rights intact, and CREATE TRIGGER requires EXECUTE
-- on the function. An applier that is not the owner and revokes first fails at
-- CREATE TRIGGER. If this repo ever applies migrations as a non-owner role,
-- revisit the order here.


-- ═══════════════════════════════════════════════════════════════════════════
-- 3. Trigger — both new columns added to the statement-level filter
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `UPDATE OF` keys off the columns NAMED in the statement, not the values, so
-- it must list every guarded column or a write naming only the new ones never
-- fires the trigger at all. DROP … IF EXISTS keeps the file re-runnable.
--
-- APPLY THIS FILE IN A SINGLE TRANSACTION. Between the DROP and the CREATE
-- below the ems_* columns are unguarded on a live table. Postgres DDL is
-- transactional, so BEGIN … COMMIT (or psql --single-transaction) closes the
-- gap completely; applied statement-by-statement over an interactive session
-- it is real, and its length is however long the two statements are apart.
-- Low consequence for THIS migration — the new columns are unwritten and the
-- microgrids RLS policy still refuses cross-org writers throughout — but the
-- property belongs to the DROP/CREATE pair, not to this migration's contents,
-- so it holds for every future reissue of this trigger.

DROP TRIGGER IF EXISTS trg_microgrids_guard_ems_config ON public.microgrids;
CREATE TRIGGER trg_microgrids_guard_ems_config
  BEFORE UPDATE OF
    ems_type,
    ems_backend_url,
    ems_aws_region,
    ems_aws_access_key_id,
    ems_aws_secret_access_key_encrypted,
    ems_basic_auth_username,
    ems_basic_auth_password_encrypted,
    ems_known_edge_ids
  ON public.microgrids
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_microgrids_guard_ems_config();

REVOKE EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_microgrids_guard_ems_config() TO service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- 4. Password read — service_role only, mirroring fn_get_ems_secret post-00049
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 00049 revoked fn_get_ems_secret and fn_ems_decrypt_secret from
-- `authenticated` to close a decrypt oracle. This function is created with the
-- post-00049 grants from the start rather than inheriting them later.
--
-- The body's permission gate is deliberately kept even though `authenticated`
-- cannot execute the function at all — it is the guard that would matter if
-- the grant were ever widened. It is NOT what does the work today; the grant
-- is. Anyone reading this body and concluding that org managers can call it
-- would be reading the wrong control.
--
-- Callers MUST go through `getEmsSecretForMicrogrid`'s sibling in
-- `src/lib/openems/config.ts` rather than invoking this directly: that helper
-- authorizes by reading the microgrid row on the caller's own RLS-evaluated
-- client and treats "no row" as terminal BEFORE any service-role client is
-- constructed. Called directly from a service-role client, this function
-- contributes no authorization whatsoever.

CREATE OR REPLACE FUNCTION public.fn_get_ems_basic_auth_password(_microgrid_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_ciphertext BYTEA;
BEGIN
  IF NOT (auth.role() = 'service_role' OR user_can_access_microgrid(_microgrid_id)) THEN
    RETURN NULL;
  END IF;

  SELECT ems_basic_auth_password_encrypted INTO v_ciphertext
    FROM microgrids
    WHERE id = _microgrid_id
    LIMIT 1;

  IF v_ciphertext IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN fn_ems_decrypt_secret(v_ciphertext);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_get_ems_basic_auth_password(UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.fn_get_ems_basic_auth_password(UUID) TO service_role;
