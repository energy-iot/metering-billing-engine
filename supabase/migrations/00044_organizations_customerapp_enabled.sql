-- 00044_organizations_customerapp_enabled.sql
-- #251 — Per-org acceptance gate for customerapp (`/api/v1/*`) calls.
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- This is the **Acceptance** layer of the 4-layer trust composition for the
-- customerapp integration (#249):
--
--   * Authentication (#255 per-org token)   — "You are customerapp acting as org X."
--   * Acceptance      (THIS migration)      — "Org X has opted to accept customerapp pushes."
--   * Authorization  (#254 microgrid_id)    — "Payload microgrid_id ∈ token's org."
--   * Attribution    (#250 actor_kind/ref)  — "Who acted, on whose behalf."
--
-- A valid token alone is not enough — the org has to have opted in. This
-- gives PM a per-org rollout control AND a kill switch independent of the
-- credential layer. Every org defaults to FALSE — Aaron's org must be
-- explicitly flipped TRUE before customerapp can call any `/api/v1/*` route
-- against it.
--
-- Enforcement lives inside `resolveOrgFromToken` (src/lib/internal-auth.ts);
-- routes don't reimplement the check, so the gate cannot be bypassed by
-- forgetting it in a new endpoint.
--
-- ── Column add ────────────────────────────────────────────────────────────

ALTER TABLE organizations
  ADD COLUMN customerapp_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN organizations.customerapp_enabled IS
  'Per-org opt-in for the customerapp /api/v1/* integration (#251). FALSE by default — must be flipped TRUE by a super_admin (via SQL or future MBE UI) at activation time. Acts as the per-org kill switch independent of the per-org token (#255).';

-- ── Helper function ───────────────────────────────────────────────────────
--
-- Mirrors the existing RLS-helper pattern (`is_super_admin()`,
-- `user_can_access_org()`, `user_can_access_microgrid()` in 00002_rls.sql):
-- SECURITY DEFINER + STABLE + pinned search_path. Owner is `postgres`
-- (the default for migration-applied functions), which is what the
-- existing helpers rely on for RLS bypass when reading `user_roles`.
--
-- Returns NULL only if the org doesn't exist (FK on tokens prevents this
-- in practice, but the caller treats NULL as "not enabled" via the
-- truthiness check in `resolveOrgFromToken`).

CREATE OR REPLACE FUNCTION customerapp_enabled_for_org(_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT customerapp_enabled FROM organizations WHERE id = _org_id;
$$;

COMMENT ON FUNCTION customerapp_enabled_for_org(UUID) IS
  '#251 — returns organizations.customerapp_enabled for the given org_id, or NULL if the org does not exist. Called from resolveOrgFromToken (src/lib/internal-auth.ts) after token validation to enforce the per-org acceptance gate. SECURITY DEFINER so the service-role auth path can resolve it without depending on the caller`s RLS context.';

-- Lock down EXECUTE: the helper exposes a row-presence signal on
-- `organizations`, so don't expose it to anon. service_role bypasses
-- grants by design; authenticated is allowed so the future MBE UI for
-- toggling the flag (super_admin only — enforced by RLS on organizations)
-- can call it to render current state.
REVOKE EXECUTE ON FUNCTION customerapp_enabled_for_org(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION customerapp_enabled_for_org(UUID) TO authenticated, service_role;
