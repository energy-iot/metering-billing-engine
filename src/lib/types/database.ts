export type Organization = {
  id: string;
  name: string;
  created_at: string;
};

export type Microgrid = {
  id: string;
  org_id: string;
  name: string;
  location: string | null;
  currency: string;
  created_at: string;
};

export type Meter = {
  id: string;
  microgrid_id: string;
  name: string;
  data_source_type: string;
  data_source_config: Record<string, unknown>;
  meter_type: string | null;
  created_at: string;
};

export type Tenant = {
  id: string;
  microgrid_id: string;
  name: string;
  phone: string | null;
  email: string | null;
  meter_id: string | null;
  created_at: string;
};

export type TierConfig = {
  label: string;
  min_kwh: number;
  max_kwh: number | null;
  rate_per_kwh: number;
};

export type RateSchedule = {
  id: string;
  microgrid_id: string;
  tiers: TierConfig[];
  service_charge: number;
  tax_rate: number;
  created_at: string;
};

export type BillingPeriodStatus = "draft" | "closed";

export type BillingPeriod = {
  id: string;
  microgrid_id: string;
  start_date: string;
  end_date: string;
  status: BillingPeriodStatus;
  created_at: string;
  closed_at: string | null;
};

export type TierBreakdown = {
  label: string;
  kwh: number;
  amount: number;
};

export type BillingLineItem = {
  id: string;
  billing_period_id: string;
  tenant_id: string;
  meter_id: string | null;
  usage_kwh: number;
  start_kwh: number | null;
  end_kwh: number | null;
  tier_breakdown: TierBreakdown[];
  total_amount: number;
  created_at: string;
};

export type UserRole = "system_admin" | "org_admin";

export type UserRoleRecord = {
  id: string;
  user_id: string;
  org_id: string | null;
  role: UserRole;
  created_at: string;
};
