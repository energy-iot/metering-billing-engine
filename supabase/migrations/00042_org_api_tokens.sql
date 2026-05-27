-- 00042_org_api_tokens.sql
-- #255 — per-org API tokens (replaces the dead-code INTERNAL_API_KEY model
-- introduced by PR #246). This is the Authentication layer of the 4-layer
-- trust composition for the customerapp integration (#249).
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- PR #246 shipped a shared `INTERNAL_API_KEY` env-var auth model. That
-- env var is never set in production — the route handlers are dead code
-- until this ticket lands. #255 replaces them with a per-org token system
-- so the credential boundary matches the RLS / multi-tenant boundary.
--
-- ── Token shape (Architect refinement, 2026-05-26) ────────────────────────
--
-- Plain text:  mbe_<env>_<lookup>_<secret>
--   * <env>    — 4 chars (e.g. 'prod', 'stag', 'dev_') — env marker, used
--                for log identification + accidental-cross-env-paste detection.
--   * <lookup> — 8 hex chars (32 bits of entropy); the NON-SECRET index key.
--   * <secret> — 43 chars base64url (32 bytes); the entropy that argon2id
--                hashes.
--
-- Total length: 61 chars. Easy to copy; visually identifiable as MBE.
--
-- argon2id is non-deterministic (random salt per hash), so we cannot look
-- up by hash. Industry-standard fix (Stripe / GitHub / similar): split into
-- a non-secret indexed lookup column + secret argon2-hashed column. The
-- secret never appears in plain text in the DB; it is only returned once at
-- creation time and verified against the stored hash on every auth.
--
-- ── Schema ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS org_api_tokens (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_lookup  TEXT NOT NULL,
  token_hash    TEXT NOT NULL,
  env_prefix    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  last_used_at  TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,
  CHECK (token_lookup ~ '^[0-9a-f]{8}$'),
  CHECK (env_prefix ~ '^[a-z0-9_]{2,8}$')
);

COMMENT ON TABLE org_api_tokens IS
  'Per-org API tokens (#255). Replaces the shared INTERNAL_API_KEY model. Token plaintext is mbe_<env>_<lookup>_<secret>; we store token_lookup (non-secret, indexed) and token_hash (argon2id over the secret).';

COMMENT ON COLUMN org_api_tokens.name IS
  'Operator-chosen label, surfaced in audit log as actor_ref.';

COMMENT ON COLUMN org_api_tokens.token_lookup IS
  '8 hex chars; non-secret; indexed. Server resolves the row by this prefix, then argon2-verifies the secret remainder against token_hash.';

COMMENT ON COLUMN org_api_tokens.token_hash IS
  'argon2id encoded hash (~95 chars) of the secret remainder. Verified per-request; never logged or returned.';

COMMENT ON COLUMN org_api_tokens.env_prefix IS
  'Env marker (e.g. ''prod'', ''stag'', ''dev_''). Captured at creation time so logs can identify which env a token belongs to without inspecting the plaintext.';

COMMENT ON COLUMN org_api_tokens.revoked_at IS
  'Set immediately on revoke/regenerate (#256 UI). Hard cutover — no grace window. Old tokens 401 on next request.';

-- Lookup uniqueness applies only to ACTIVE (not revoked) tokens. Revoked
-- rows retain the old lookup for forensic / audit reference, and a fresh
-- regenerate could in principle reuse the same 32-bit lookup (vanishingly
-- unlikely but the partial index keeps the invariant honest).
CREATE UNIQUE INDEX IF NOT EXISTS org_api_tokens_lookup_active_uq
  ON org_api_tokens(token_lookup)
  WHERE revoked_at IS NULL;

-- Listing for the org-admin UI (#256) — most-recent-first per org, active
-- tokens only. Revoked rows show up in a separate "history" panel that
-- doesn't need this index.
CREATE INDEX IF NOT EXISTS org_api_tokens_org_active_idx
  ON org_api_tokens(org_id, created_at DESC)
  WHERE revoked_at IS NULL;

-- ── RLS ──────────────────────────────────────────────────────────────────
--
-- The token-auth path itself uses the service-role client (no auth.uid()
-- yet at the moment of lookup), so RLS does NOT block the auth flow. The
-- #256 org-admin UI for managing tokens DOES run as the human user
-- (auth.uid() = org_manager), so we lock the table to:
--   * super_admin: full access
--   * org_manager scoped to the row's org_id: full access
--
-- This mirrors the user_roles / payment-secret pattern; consumers in the
-- web UI use the SSR Supabase client (per-request user-bound) and thus
-- evaluate RLS naturally. Service-role bypasses RLS by design and continues
-- to work for the auth path.

ALTER TABLE org_api_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS org_api_tokens_super_admin ON org_api_tokens;
CREATE POLICY org_api_tokens_super_admin ON org_api_tokens
  FOR ALL
  USING (is_super_admin())
  WITH CHECK (is_super_admin());

DROP POLICY IF EXISTS org_api_tokens_org_manager ON org_api_tokens;
CREATE POLICY org_api_tokens_org_manager ON org_api_tokens
  FOR ALL
  USING (user_can_access_org(org_id))
  WITH CHECK (user_can_access_org(org_id));
