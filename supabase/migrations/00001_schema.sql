-- Organizations
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Microgrids
CREATE TABLE microgrids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  location TEXT,
  currency TEXT NOT NULL DEFAULT 'UGX',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Meters
CREATE TABLE meters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data_source_type TEXT NOT NULL DEFAULT 'openems',
  data_source_config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tenants
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  meter_id UUID REFERENCES meters(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rate schedules
CREATE TABLE rate_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  tiers JSONB NOT NULL DEFAULT '[]',
  service_charge NUMERIC NOT NULL DEFAULT 0,
  tax_rate NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Billing periods
CREATE TYPE billing_period_status AS ENUM ('draft', 'closed');

CREATE TABLE billing_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status billing_period_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

-- Billing line items
CREATE TABLE billing_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_period_id UUID NOT NULL REFERENCES billing_periods(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  meter_id UUID REFERENCES meters(id) ON DELETE SET NULL,
  usage_kwh NUMERIC NOT NULL DEFAULT 0,
  tier_breakdown JSONB NOT NULL DEFAULT '[]',
  total_amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User roles
CREATE TYPE user_role AS ENUM ('system_admin', 'org_admin');

CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  role user_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(user_id, org_id)
);

-- Indexes
CREATE INDEX idx_microgrids_org_id ON microgrids(org_id);
CREATE INDEX idx_meters_microgrid_id ON meters(microgrid_id);
CREATE INDEX idx_tenants_microgrid_id ON tenants(microgrid_id);
CREATE INDEX idx_tenants_meter_id ON tenants(meter_id);
CREATE INDEX idx_rate_schedules_microgrid_id ON rate_schedules(microgrid_id);
CREATE INDEX idx_billing_periods_microgrid_id ON billing_periods(microgrid_id);
CREATE INDEX idx_billing_line_items_billing_period_id ON billing_line_items(billing_period_id);
CREATE INDEX idx_user_roles_user_id ON user_roles(user_id);
CREATE INDEX idx_user_roles_org_id ON user_roles(org_id);
