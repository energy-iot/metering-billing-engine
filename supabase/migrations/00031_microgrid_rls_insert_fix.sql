-- 00031_microgrid_rls_insert_fix.sql
-- Fix: org_manager cannot INSERT microgrids because the existing
-- "Authorized users can access microgrids" policy resolves access via the
-- target row's own id (microgrids → communities → org_id) — but on INSERT
-- the SECURITY-DEFINER STABLE helper's snapshot does not see the pending
-- new row, so the resolved org_id is NULL and user_can_access_org(NULL)
-- returns false for non-super_admins. (Super_admins pass via the
-- is_super_admin() short-circuit, which is why the bug went unnoticed.)
--
-- Fix: introduce user_can_access_community(_community_id) which delegates
-- to user_can_access_org() via communities.org_id (a row that already
-- exists at INSERT time), then point the microgrids policy at the new
-- row's community_id (a parent-pointing column), mirroring the pattern
-- used by every other table policy.
--
-- Scope: targeted fix. user_can_access_microgrid() is unchanged and
-- continues to back SELECT/UPDATE/DELETE on existing microgrid rows
-- elsewhere in the schema. Body refactor of user_can_access_microgrid is
-- explicitly out of scope (file a separate ticket).

-- ── Helper: user_can_access_community ───────────────────────────────────
-- Mirrors user_can_access_microgrid (00002_rls.sql:77-90): SECURITY
-- DEFINER, STABLE, search_path pinned. Owned by postgres so it bypasses
-- RLS when reading communities/user_roles via user_can_access_org.
CREATE OR REPLACE FUNCTION user_can_access_community(_community_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT user_can_access_org((
    SELECT org_id FROM communities WHERE id = _community_id
  ));
$$;

-- ── Repoint the microgrids policy at the parent column ──────────────────
-- DROP+CREATE matches the codebase convention (no other migration uses
-- ALTER POLICY). IF EXISTS is mandatory for re-run safety: cloud deploys
-- are manual via psql per CLAUDE.md, and re-running this migration must
-- not error.
--
-- Policy name MUST remain byte-identical to the existing string —
-- monitoring + rollback procedures depend on it.
DROP POLICY IF EXISTS "Authorized users can access microgrids" ON microgrids;

CREATE POLICY "Authorized users can access microgrids"
  ON microgrids FOR ALL
  USING (user_can_access_community(community_id))
  WITH CHECK (user_can_access_community(community_id));
