-- Enable RLS on all tables
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE microgrids ENABLE ROW LEVEL SECURITY;
ALTER TABLE meters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_line_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_roles ENABLE ROW LEVEL SECURITY;

-- Helper function: check if user is system admin
CREATE OR REPLACE FUNCTION is_system_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_roles
    WHERE user_id = auth.uid() AND role = 'system_admin'
  );
$$ LANGUAGE sql SECURITY DEFINER;

-- Helper function: get org IDs the user belongs to
CREATE OR REPLACE FUNCTION user_org_ids()
RETURNS SETOF UUID AS $$
  SELECT org_id FROM user_roles
  WHERE user_id = auth.uid() AND org_id IS NOT NULL;
$$ LANGUAGE sql SECURITY DEFINER;

-- Organizations: system_admin sees all, org_admin sees their own
CREATE POLICY "System admins can do everything with organizations"
  ON organizations FOR ALL USING (is_system_admin());

CREATE POLICY "Org admins can view their organizations"
  ON organizations FOR SELECT
  USING (id IN (SELECT user_org_ids()));

-- Microgrids: accessible if user can access the org
CREATE POLICY "System admins can do everything with microgrids"
  ON microgrids FOR ALL USING (is_system_admin());

CREATE POLICY "Org admins can manage their microgrids"
  ON microgrids FOR ALL
  USING (org_id IN (SELECT user_org_ids()));

-- Meters: accessible via microgrid -> org chain
CREATE POLICY "System admins can do everything with meters"
  ON meters FOR ALL USING (is_system_admin());

CREATE POLICY "Org admins can manage their meters"
  ON meters FOR ALL
  USING (microgrid_id IN (
    SELECT id FROM microgrids WHERE org_id IN (SELECT user_org_ids())
  ));

-- Tenants: same pattern
CREATE POLICY "System admins can do everything with tenants"
  ON tenants FOR ALL USING (is_system_admin());

CREATE POLICY "Org admins can manage their tenants"
  ON tenants FOR ALL
  USING (microgrid_id IN (
    SELECT id FROM microgrids WHERE org_id IN (SELECT user_org_ids())
  ));

-- Rate schedules: same pattern
CREATE POLICY "System admins can do everything with rate_schedules"
  ON rate_schedules FOR ALL USING (is_system_admin());

CREATE POLICY "Org admins can manage their rate_schedules"
  ON rate_schedules FOR ALL
  USING (microgrid_id IN (
    SELECT id FROM microgrids WHERE org_id IN (SELECT user_org_ids())
  ));

-- Billing periods: same pattern
CREATE POLICY "System admins can do everything with billing_periods"
  ON billing_periods FOR ALL USING (is_system_admin());

CREATE POLICY "Org admins can manage their billing_periods"
  ON billing_periods FOR ALL
  USING (microgrid_id IN (
    SELECT id FROM microgrids WHERE org_id IN (SELECT user_org_ids())
  ));

-- Billing line items: same pattern via billing_period -> microgrid -> org
CREATE POLICY "System admins can do everything with billing_line_items"
  ON billing_line_items FOR ALL USING (is_system_admin());

CREATE POLICY "Org admins can manage their billing_line_items"
  ON billing_line_items FOR ALL
  USING (billing_period_id IN (
    SELECT bp.id FROM billing_periods bp
    JOIN microgrids m ON bp.microgrid_id = m.id
    WHERE m.org_id IN (SELECT user_org_ids())
  ));

-- User roles: users can see their own roles, system admins can manage all
CREATE POLICY "Users can view their own roles"
  ON user_roles FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "System admins can manage all roles"
  ON user_roles FOR ALL USING (is_system_admin());
