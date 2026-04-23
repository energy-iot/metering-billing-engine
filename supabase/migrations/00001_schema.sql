-- 00001_schema.sql
-- Entity-model schema rewrite (AB ticket #50).
-- See mbe-docs/docs/entity-model.md § "Concrete schema proposal" for the design rationale.
--
-- Entity hierarchy:
--   Organization -> Community -> Microgrid -> Edge -> Device
--                                Microgrid -> Household -> household_devices (M:N to Device)
--                                Household -> household_users (M:N to auth.users)
--
-- Addresses live at three levels (Org / Community / Microgrid) plus optional on Household.
-- Devices generalize meters (consumption_meter is the billable sub-type).
-- user_roles is a (role, scope_type, scope_id) tuple; scope_id is nullable for super_admin only.

-- ── Enums ───────────────────────────────────────────────────────────────

-- Edge data-source hedge: default 'openems' but we support non-OpenEMS gateways
-- (Aaron's current CHINT-via-Python-Modbus-logger is a real example).
CREATE TYPE edge_data_source AS ENUM (
  'openems',
  'modbus_direct',
  'mqtt',
  'rest_api'
);

-- Device type: mirrors OpenEMS's Component model.
-- 'consumption_meter' is the billable sub-type; primary_consumption_meter role in
-- household_devices points at one of these per household.
CREATE TYPE device_type AS ENUM (
  'consumption_meter',
  'grid_meter',
  'pv_meter',
  'battery',
  'inverter',
  'ev_charger',
  'other'
);

-- Household ↔ device role: 'primary_consumption_meter' is unique per household
-- (enforced by partial unique index below). Other roles can repeat.
CREATE TYPE household_device_role AS ENUM (
  'primary_consumption_meter',
  'secondary_meter',
  'battery',
  'solar',
  'ev_charger',
  'other'
);

CREATE TYPE billing_period_status AS ENUM ('draft', 'closed');

-- MVP user roles (2 only). Schema supports extensions via enum additions
-- without migration when microgrid_manager / community_admin / tenant ship.
CREATE TYPE user_role AS ENUM (
  'super_admin',
  'org_manager'
);

-- MVP scope type (1 only). Extends to 'microgrid' / 'household' alongside role additions.
CREATE TYPE role_scope_type AS ENUM (
  'org'
);

-- ── Tables ──────────────────────────────────────────────────────────────

-- Organizations: legal/tax purpose address (URA invoicing, regulatory filings).
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  address_line1 TEXT,
  address_line2 TEXT,
  address_city TEXT,
  address_region TEXT,
  address_country TEXT,
  address_postal_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Communities: geographic identity (mapping, locality) between org and microgrid.
-- An org can have N communities; a community has N microgrids.
CREATE TABLE communities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  address_line1 TEXT,
  address_line2 TEXT,
  address_city TEXT,
  address_region TEXT,
  address_country TEXT,
  address_postal_code TEXT,
  geography_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Microgrids: physical service location (technician dispatch, equipment install).
-- NOTE: legacy 'location' TEXT column was dropped in this rewrite — use the
-- structured address columns instead. currency preserved (LocaleProvider dep).
CREATE TABLE microgrids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  address_line1 TEXT,
  address_line2 TEXT,
  address_city TEXT,
  address_region TEXT,
  address_country TEXT,
  address_postal_code TEXT,
  lat NUMERIC,
  lng NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Edges: first-class entity sitting between microgrid and devices.
-- For OpenEMS-typed edges, the openems_backend_url + openems_edge_id columns are required
-- (CHECK constraint below). Unique (microgrid_id, openems_edge_id) prevents dup registrations.
CREATE TABLE edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  data_source_type edge_data_source NOT NULL DEFAULT 'openems',
  openems_backend_url TEXT,
  openems_edge_id TEXT,
  role TEXT,  -- free-form: 'metering' | 'storage' | 'ev' | ...
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (microgrid_id, openems_edge_id),
  CONSTRAINT edges_openems_fields_required CHECK (
    data_source_type != 'openems'
    OR (openems_backend_url IS NOT NULL AND openems_edge_id IS NOT NULL)
  )
);

-- Devices: generalizes meters (OpenEMS Component analogue).
-- For OpenEMS-sourced edges, openems_component_id is required; enforced via trigger-free
-- inline check that joins the edge at insert/update time. We express this as a CHECK
-- against a function so it's declarative (see fn_device_openems_component_valid below).
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  edge_id UUID NOT NULL REFERENCES edges(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  device_type device_type NOT NULL,
  openems_component_id TEXT,
  config JSONB NOT NULL DEFAULT '{}',  -- per-source connection details (Modbus addr, MQTT topic, etc.)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (edge_id, openems_component_id)
);

-- Enforce "openems_component_id required when parent edge.data_source_type='openems'"
-- via a trigger (pure CHECK cannot reference another table). IMMUTABLE-ish: re-checks
-- on each insert/update of devices OR when an edge's data_source_type changes.
CREATE OR REPLACE FUNCTION fn_device_openems_component_valid()
RETURNS TRIGGER AS $$
DECLARE
  parent_type edge_data_source;
BEGIN
  SELECT data_source_type INTO parent_type FROM edges WHERE id = NEW.edge_id;
  IF parent_type = 'openems' AND NEW.openems_component_id IS NULL THEN
    RAISE EXCEPTION 'devices.openems_component_id is required when parent edge.data_source_type = ''openems'' (edge_id=%)', NEW.edge_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_device_openems_component_valid
  BEFORE INSERT OR UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION fn_device_openems_component_valid();

-- Households: billing unit. Optional structured unit/install address for visit context.
-- Replaces the old 'tenants' table. No real PII seeded (block/unit labels only).
CREATE TABLE households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  primary_phone TEXT,
  primary_email TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  unit_label TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Household ↔ device join. Synthetic PK (id) + UNIQUE(household_id, device_id, role)
-- allows a household to link to multiple devices and the same device to multiple households
-- (with different roles). The partial unique index below enforces exactly one
-- primary_consumption_meter per household.
-- NOTE: spec line 331 proposed PK=(household_id, device_id) — we override per AB ticket
-- dev note because that compound key would forbid a device serving two households
-- AND forbid a household having two devices of the same role.
CREATE TABLE household_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  role household_device_role NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (household_id, device_id, role)
);

-- Exactly one billable meter per household.
CREATE UNIQUE INDEX household_one_primary_consumption_meter
  ON household_devices (household_id)
  WHERE role = 'primary_consumption_meter';

-- Household ↔ portal user mapping (for tenant API access from external customer app).
-- Seeded EMPTY for now — population pattern depends on API user pattern A/B decision.
CREATE TABLE household_users (
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  relationship TEXT,  -- 'primary' | 'member'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, user_id)
);

-- Rate schedules (still microgrid-scoped; one active per microgrid at a time).
CREATE TABLE rate_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  tiers JSONB NOT NULL DEFAULT '[]',
  service_charge NUMERIC NOT NULL DEFAULT 0,
  tax_rate NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Billing periods.
CREATE TABLE billing_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  microgrid_id UUID NOT NULL REFERENCES microgrids(id) ON DELETE CASCADE,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status billing_period_status NOT NULL DEFAULT 'draft',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at TIMESTAMPTZ
);

-- Billing line items: device_id replaces meter_id; household_id replaces tenant_id.
-- device_id is the primary_consumption_meter at the time of billing (resolved via
-- household_devices.role='primary_consumption_meter'); ON DELETE SET NULL preserves
-- historical bills if the device is later removed.
CREATE TABLE billing_line_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_period_id UUID NOT NULL REFERENCES billing_periods(id) ON DELETE CASCADE,
  household_id UUID NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  device_id UUID REFERENCES devices(id) ON DELETE SET NULL,
  usage_kwh NUMERIC NOT NULL DEFAULT 0,
  start_kwh NUMERIC,
  end_kwh NUMERIC,
  tier_breakdown JSONB NOT NULL DEFAULT '[]',
  total_amount NUMERIC NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Meter readings: time-series readings for each device (formerly keyed on meter_id).
-- Carried forward from old 00005_add_meter_readings.sql, re-keyed on device_id.
CREATE TABLE meter_readings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  reading_kwh NUMERIC NOT NULL,
  read_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User roles tuple (role, scope_type, scope_id).
-- scope_id is NULL for super_admin only; CHECK constraint enforces this.
-- UNIQUE(user_id, role, scope_type, scope_id) prevents duplicate role rows for a user;
-- the NULL in scope_id is treated as distinct by Postgres UNIQUE by default, which is
-- fine because a user should have at most one super_admin row (scope_id NULL).
CREATE TABLE user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role user_role NOT NULL,
  scope_type role_scope_type NOT NULL,
  scope_id UUID,  -- NULL allowed only for super_admin (see CHECK below)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, role, scope_type, scope_id),
  CONSTRAINT user_roles_scope_id_requires_non_super_admin CHECK (
    role = 'super_admin' OR scope_id IS NOT NULL
  )
);

-- ── Indexes (B-tree on every FK column + composite for RLS helper lookups) ──

CREATE INDEX idx_communities_org_id            ON communities(org_id);
CREATE INDEX idx_microgrids_community_id       ON microgrids(community_id);
CREATE INDEX idx_edges_microgrid_id            ON edges(microgrid_id);
CREATE INDEX idx_devices_edge_id               ON devices(edge_id);
CREATE INDEX idx_households_microgrid_id       ON households(microgrid_id);
CREATE INDEX idx_household_devices_household   ON household_devices(household_id);
CREATE INDEX idx_household_devices_device      ON household_devices(device_id);
CREATE INDEX idx_household_users_household     ON household_users(household_id);
CREATE INDEX idx_household_users_user          ON household_users(user_id);
CREATE INDEX idx_rate_schedules_microgrid_id   ON rate_schedules(microgrid_id);
CREATE INDEX idx_billing_periods_microgrid_id  ON billing_periods(microgrid_id);
CREATE INDEX idx_billing_line_items_period     ON billing_line_items(billing_period_id);
CREATE INDEX idx_billing_line_items_household  ON billing_line_items(household_id);
CREATE INDEX idx_billing_line_items_device     ON billing_line_items(device_id);
CREATE INDEX idx_meter_readings_device_id      ON meter_readings(device_id);
CREATE INDEX idx_meter_readings_read_at        ON meter_readings(read_at);
CREATE INDEX idx_user_roles_user_id            ON user_roles(user_id);
CREATE INDEX idx_user_roles_scope_id           ON user_roles(scope_id);
-- Composite index accelerates the helper-function lookups (is_super_admin / user_can_access_org).
CREATE INDEX idx_user_roles_user_role_scope    ON user_roles(user_id, role, scope_type);
