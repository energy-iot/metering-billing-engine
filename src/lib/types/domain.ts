/**
 * domain.ts — flat type aliases over the generated Supabase schema.
 *
 * Import from "@/lib/types/domain" — never import database.gen.ts directly in
 * application code. This alias layer decouples product code from the Supabase
 * codegen output and makes renames a single-file change.
 *
 * Run `npm run db:types` after every schema change to regenerate database.gen.ts,
 * then update this file if any table/column/enum names changed.
 */
import { Constants } from "./database.gen";
import type { Database } from "./database.gen";

// ── Tables ────────────────────────────────────────────────────────────────────

export type Organization = Database["public"]["Tables"]["organizations"]["Row"];
export type Community = Database["public"]["Tables"]["communities"]["Row"];
export type Microgrid = Database["public"]["Tables"]["microgrids"]["Row"];
export type Edge = Database["public"]["Tables"]["edges"]["Row"];
export type Device = Database["public"]["Tables"]["devices"]["Row"];
export type Household = Database["public"]["Tables"]["households"]["Row"];
export type HouseholdDevice =
  Database["public"]["Tables"]["household_devices"]["Row"];
export type HouseholdUser =
  Database["public"]["Tables"]["household_users"]["Row"];
/** rate_schedules row with JSONB `tiers` narrowed to TierConfig[]. */
export type RateSchedule = Omit<
  Database["public"]["Tables"]["rate_schedules"]["Row"],
  "tiers"
> & { tiers: TierConfig[] };

export type BillingPeriod =
  Database["public"]["Tables"]["billing_periods"]["Row"];

/** billing_line_items row with JSONB `tier_breakdown` narrowed to TierBreakdown[]. */
export type BillingLineItem = Omit<
  Database["public"]["Tables"]["billing_line_items"]["Row"],
  "tier_breakdown"
> & { tier_breakdown: TierBreakdown[] };
export type UserRoleRecord = Database["public"]["Tables"]["user_roles"]["Row"];
export type UserProfile = Database["public"]["Tables"]["user_profiles"]["Row"];

/**
 * user_directory row — the joined VIEW over auth.users × user_profiles ×
 * user_roles. Defined in migration 00013 with security_invoker = true.
 * Column nullability mirrors the LEFT JOINs: a user with no profile or
 * no role row surfaces with NULL columns.
 */
export type UserDirectoryRow =
  Database["public"]["Views"]["user_directory"]["Row"];

// ── Views ─────────────────────────────────────────────────────────────────────

/** Row from the microgrid_recent_activity VIEW (migration 00011). */
export type MicrogridRecentActivityRow =
  Database["public"]["Views"]["microgrid_recent_activity"]["Row"];

// ── Enum runtime values ───────────────────────────────────────────────────────

/** Runtime tuple of all valid edge_data_source enum values (Postgres enum order). */
export const EDGE_DATA_SOURCE_VALUES = Constants.public.Enums.edge_data_source;

// ── Enums (literal-union types) ───────────────────────────────────────────────

export type UserRole = Database["public"]["Enums"]["user_role"];
export type RoleScopeType = Database["public"]["Enums"]["role_scope_type"];
export type EdgeDataSource = Database["public"]["Enums"]["edge_data_source"];
export type DeviceType = Database["public"]["Enums"]["device_type"];
export type HouseholdDeviceRole =
  Database["public"]["Enums"]["household_device_role"];
export type BillingPeriodStatus =
  Database["public"]["Enums"]["billing_period_status"];

// ── Shared helper types ───────────────────────────────────────────────────────

/** Tier config embedded in rate_schedules.tiers JSONB. */
export type TierConfig = {
  label: string;
  min_kwh: number;
  max_kwh: number | null;
  rate_per_kwh: number;
};

/** Tier breakdown embedded in billing_line_items.tier_breakdown JSONB. */
export type TierBreakdown = {
  label: string;
  kwh: number;
  amount: number;
};
