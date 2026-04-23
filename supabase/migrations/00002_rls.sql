-- 00002_rls.sql
-- Row-Level Security policies for the entity-model schema (AB ticket #50).
--
-- Design:
--   - Three SECURITY DEFINER helpers centralize access checks:
--       is_super_admin()                       -> bool
--       user_can_access_org(_org_id UUID)      -> bool
--       user_can_access_microgrid(_mg UUID)    -> bool
--   - Every policy chains through these helpers — no inline JOIN chains in USING clauses.
--   - Policies use `FOR ALL` (not split per-verb) to match the existing schema's pattern.
--     Do NOT split these into per-verb policies without coordinating a codebase-wide change;
--     the adapter/API layer assumes FOR-ALL semantics for system_admin / org_manager.
--   - The user_roles SELECT policy "Users can view their own roles" is preserved so clients
--     can read their own role list directly; helpers are SECURITY DEFINER so they're
--     unaffected by user_roles RLS.
--
-- Old helpers is_system_admin() / user_org_ids() are dropped — they reference the pre-rewrite
-- schema (org_id column on user_roles) and the old 'system_admin' enum value.

-- ── Enable RLS on every public table ────────────────────────────────────

ALTER TABLE organizations       ENABLE ROW LEVEL SECURITY;
ALTER TABLE communities         ENABLE ROW LEVEL SECURITY;
ALTER TABLE microgrids          ENABLE ROW LEVEL SECURITY;
ALTER TABLE edges               ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE households          ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_devices   ENABLE ROW LEVEL SECURITY;
ALTER TABLE household_users     ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_schedules      ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_periods     ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_line_items  ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_readings      ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles          ENABLE ROW LEVEL SECURITY;

-- ── Helper functions (SECURITY DEFINER, owned by postgres) ──────────────
-- NOTE: SECURITY DEFINER + postgres ownership bypasses RLS when these helpers query
-- user_roles. search_path pinned to 'public, pg_temp' per Supabase best-practice to
-- prevent search-path injection.

-- True iff auth.uid() has any super_admin role row.
CREATE OR REPLACE FUNCTION is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = auth.uid()
      AND role = 'super_admin'
  );
$$;

-- True iff the caller is a super_admin OR holds org_manager scoped to _org_id.
CREATE OR REPLACE FUNCTION user_can_access_org(_org_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    is_super_admin()
    OR EXISTS (
      SELECT 1 FROM user_roles
      WHERE user_id = auth.uid()
        AND role = 'org_manager'
        AND scope_type = 'org'
        AND scope_id = _org_id
    );
$$;

-- True iff the caller can access the parent org of _microgrid_id.
-- Resolves via microgrids -> communities -> org_id.
CREATE OR REPLACE FUNCTION user_can_access_microgrid(_microgrid_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT user_can_access_org((
    SELECT c.org_id
    FROM microgrids m
    JOIN communities c ON c.id = m.community_id
    WHERE m.id = _microgrid_id
  ));
$$;

-- ── Drop old helpers if present (idempotent; handles upgrade path) ──────
DROP FUNCTION IF EXISTS is_system_admin();
DROP FUNCTION IF EXISTS user_org_ids();

-- ── Policies ─────────────────────────────────────────────────────────────
-- Pattern: one FOR ALL policy per table, chaining through the helpers.
-- DO NOT split into per-verb policies without coordinating.

-- organizations
CREATE POLICY "Authorized users can access organizations"
  ON organizations FOR ALL
  USING (user_can_access_org(id))
  WITH CHECK (user_can_access_org(id));

-- communities — accessible if user can access parent org
CREATE POLICY "Authorized users can access communities"
  ON communities FOR ALL
  USING (user_can_access_org(org_id))
  WITH CHECK (user_can_access_org(org_id));

-- microgrids — accessible via microgrid helper
CREATE POLICY "Authorized users can access microgrids"
  ON microgrids FOR ALL
  USING (user_can_access_microgrid(id))
  WITH CHECK (user_can_access_microgrid(id));

-- edges
CREATE POLICY "Authorized users can access edges"
  ON edges FOR ALL
  USING (user_can_access_microgrid(microgrid_id))
  WITH CHECK (user_can_access_microgrid(microgrid_id));

-- devices — via parent edge
CREATE POLICY "Authorized users can access devices"
  ON devices FOR ALL
  USING (
    user_can_access_microgrid((SELECT microgrid_id FROM edges WHERE id = devices.edge_id))
  )
  WITH CHECK (
    user_can_access_microgrid((SELECT microgrid_id FROM edges WHERE id = devices.edge_id))
  );

-- households
CREATE POLICY "Authorized users can access households"
  ON households FOR ALL
  USING (user_can_access_microgrid(microgrid_id))
  WITH CHECK (user_can_access_microgrid(microgrid_id));

-- household_devices — via parent household
CREATE POLICY "Authorized users can access household_devices"
  ON household_devices FOR ALL
  USING (
    user_can_access_microgrid((SELECT microgrid_id FROM households WHERE id = household_devices.household_id))
  )
  WITH CHECK (
    user_can_access_microgrid((SELECT microgrid_id FROM households WHERE id = household_devices.household_id))
  );

-- household_users — seeded empty for MVP; admins can manage future rows via household.
CREATE POLICY "Authorized users can access household_users"
  ON household_users FOR ALL
  USING (
    user_can_access_microgrid((SELECT microgrid_id FROM households WHERE id = household_users.household_id))
  )
  WITH CHECK (
    user_can_access_microgrid((SELECT microgrid_id FROM households WHERE id = household_users.household_id))
  );

-- rate_schedules
CREATE POLICY "Authorized users can access rate_schedules"
  ON rate_schedules FOR ALL
  USING (user_can_access_microgrid(microgrid_id))
  WITH CHECK (user_can_access_microgrid(microgrid_id));

-- billing_periods
CREATE POLICY "Authorized users can access billing_periods"
  ON billing_periods FOR ALL
  USING (user_can_access_microgrid(microgrid_id))
  WITH CHECK (user_can_access_microgrid(microgrid_id));

-- billing_line_items — via parent billing_period
CREATE POLICY "Authorized users can access billing_line_items"
  ON billing_line_items FOR ALL
  USING (
    user_can_access_microgrid((SELECT microgrid_id FROM billing_periods WHERE id = billing_line_items.billing_period_id))
  )
  WITH CHECK (
    user_can_access_microgrid((SELECT microgrid_id FROM billing_periods WHERE id = billing_line_items.billing_period_id))
  );

-- meter_readings — via parent device -> edge -> microgrid
CREATE POLICY "Authorized users can access meter_readings"
  ON meter_readings FOR ALL
  USING (
    user_can_access_microgrid((
      SELECT e.microgrid_id
      FROM devices d JOIN edges e ON e.id = d.edge_id
      WHERE d.id = meter_readings.device_id
    ))
  )
  WITH CHECK (
    user_can_access_microgrid((
      SELECT e.microgrid_id
      FROM devices d JOIN edges e ON e.id = d.edge_id
      WHERE d.id = meter_readings.device_id
    ))
  );

-- user_roles
-- Preserve the "Users can view their own roles" SELECT policy. Clients query
-- user_roles directly to populate UI; the helpers (SECURITY DEFINER) bypass RLS so
-- they're not affected. super_admin gets full FOR ALL via the second policy below.
CREATE POLICY "Users can view their own roles"
  ON user_roles FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "Super admins can manage all user_roles"
  ON user_roles FOR ALL
  USING (is_super_admin())
  WITH CHECK (is_super_admin());
