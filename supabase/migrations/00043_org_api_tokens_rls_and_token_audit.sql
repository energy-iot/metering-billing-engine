-- 00043_org_api_tokens_rls_and_token_audit.sql
-- #256 — org-admin UI for per-org API token management. Two structural
-- changes in one file:
--
--   1. RLS on `org_api_tokens` — split per-verb (SELECT / INSERT / UPDATE)
--      rather than the FOR ALL pattern shipped by 00042, per the #256
--      Architect appendix. The split exists so future audits can ask
--      "which verbs does org_manager actually exercise" without re-reading
--      the policy body. Same helper chain (`is_super_admin()` +
--      `user_can_access_org()`); same effective access. WITH CHECK on
--      UPDATE prevents `UPDATE … SET org_id = <other_org>` (defense in
--      depth — the FK to organizations(id) already restricts valid values,
--      but the explicit predicate documents intent).
--
--      DELETE is intentionally NOT granted via policy. The UI's "Revoke"
--      flow uses UPDATE to set `revoked_at = now()`, preserving the row
--      for audit / forensic reference. Hard DELETE remains a service-role-
--      only escape hatch.
--
--   2. `billing_audit_log` widening for non-period-scoped events. The
--      enum already carries `token_generated` / `token_revoked` /
--      `token_regenerated` (added by 00041) but the table's
--      `billing_period_id` column is NOT NULL. Token operations don't
--      belong to any billing period, so we:
--
--        a. Relax `billing_period_id` to NULL.
--        b. Add `org_id UUID NULL REFERENCES organizations(id) ON DELETE
--           CASCADE` so token events still have a scoping anchor.
--        c. Add a CHECK enforcing the invariant "exactly one of
--           billing_period_id / org_id is set" — both NULL or both set is
--           rejected. This keeps the audit chain auditable: every row is
--           reachable from EITHER a billing-period scope or an org scope,
--           never neither, never both.
--        d. Update the existing read + write RLS policies so token-scoped
--           rows are visible to org_managers (and super_admin) via
--           `user_can_access_org(org_id)` when `billing_period_id IS NULL`.
--
--      The existing `billing_audit_log_actor_consistency` CHECK (00041)
--      is unchanged — token events are human-actored (`actor_kind='human'`,
--      `actor_user_id=auth.uid()`, `actor_ref IS NULL`), which the
--      existing constraint already allows.
--
-- ── Why split per-verb on org_api_tokens (Wave D refinement) ──────────────
--
-- The FOR ALL policies shipped by 00042 are functionally correct. The split
-- here is for audit-trail clarity, not access control change. Re-applying
-- 00042's policy bodies with the same predicate yields zero behavior delta.
-- DROP+CREATE so the migration is safe to re-run.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Re-shape RLS on org_api_tokens — per-verb.
-- ═════════════════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS org_api_tokens_super_admin ON org_api_tokens;
DROP POLICY IF EXISTS org_api_tokens_org_manager ON org_api_tokens;
DROP POLICY IF EXISTS org_api_tokens_select ON org_api_tokens;
DROP POLICY IF EXISTS org_api_tokens_insert ON org_api_tokens;
DROP POLICY IF EXISTS org_api_tokens_update ON org_api_tokens;

CREATE POLICY org_api_tokens_select ON org_api_tokens FOR SELECT
  USING (is_super_admin() OR user_can_access_org(org_id));

CREATE POLICY org_api_tokens_insert ON org_api_tokens FOR INSERT
  WITH CHECK (is_super_admin() OR user_can_access_org(org_id));

CREATE POLICY org_api_tokens_update ON org_api_tokens FOR UPDATE
  USING (is_super_admin() OR user_can_access_org(org_id))
  WITH CHECK (is_super_admin() OR user_can_access_org(org_id));

-- No DELETE policy. Revoke is an UPDATE (revoked_at = now()). Hard DELETE
-- is intentionally not exposed to authenticated callers; the FK ON DELETE
-- CASCADE from organizations(id) keeps cleanup-on-org-delete sane.

GRANT SELECT, INSERT, UPDATE ON org_api_tokens TO authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. billing_audit_log — admit non-period-scoped events.
-- ═════════════════════════════════════════════════════════════════════════════

-- 2a. Relax billing_period_id.
ALTER TABLE billing_audit_log
  ALTER COLUMN billing_period_id DROP NOT NULL;

-- 2b. Add org_id (NULL — populated only for non-period-scoped events).
ALTER TABLE billing_audit_log
  ADD COLUMN IF NOT EXISTS org_id UUID NULL
    REFERENCES organizations(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_billing_audit_log_org_created_at
  ON billing_audit_log (org_id, created_at DESC)
  WHERE org_id IS NOT NULL;

-- 2c. Exactly-one-scope invariant. DROP+ADD for re-runnability.
ALTER TABLE billing_audit_log
  DROP CONSTRAINT IF EXISTS billing_audit_log_scope_consistency;
ALTER TABLE billing_audit_log
  ADD CONSTRAINT billing_audit_log_scope_consistency CHECK (
    (billing_period_id IS NOT NULL AND org_id IS NULL)
    OR
    (billing_period_id IS NULL     AND org_id IS NOT NULL)
  );

COMMENT ON CONSTRAINT billing_audit_log_scope_consistency ON billing_audit_log IS
  'Scope invariant (#256): every audit row is reachable from EXACTLY ONE of (billing_period_id, org_id). Period-scoped events (line_item_*, billing_period_created, period_closed) carry billing_period_id; org-scoped events (token_generated, token_revoked, token_regenerated) carry org_id.';

COMMENT ON COLUMN billing_audit_log.org_id IS
  'Org scope for non-period audit events (token_generated/revoked/regenerated). NULL for period-scoped events; mutually exclusive with billing_period_id per billing_audit_log_scope_consistency.';

-- 2d. Replace the read/write policies so org-scoped rows are visible.

DROP POLICY IF EXISTS "Authorized users can read billing_audit_log" ON billing_audit_log;
CREATE POLICY "Authorized users can read billing_audit_log"
  ON billing_audit_log FOR SELECT
  USING (
    -- Period-scoped rows: visible iff caller can access the period's microgrid.
    (billing_period_id IS NOT NULL AND user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_periods bp
      WHERE bp.id = billing_audit_log.billing_period_id
    )))
    OR
    -- Org-scoped rows: visible iff caller can access the org.
    (org_id IS NOT NULL AND (is_super_admin() OR user_can_access_org(org_id)))
  );

DROP POLICY IF EXISTS "Authorized users can write billing_audit_log" ON billing_audit_log;
CREATE POLICY "Authorized users can write billing_audit_log"
  ON billing_audit_log FOR INSERT
  WITH CHECK (
    (billing_period_id IS NOT NULL AND user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_periods bp
      WHERE bp.id = billing_audit_log.billing_period_id
    )))
    OR
    (org_id IS NOT NULL AND (is_super_admin() OR user_can_access_org(org_id)))
  );

-- No UPDATE policy. No DELETE policy. Append-only invariant from 00029
-- preserved.
