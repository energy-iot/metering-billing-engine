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
export type OrgApiToken =
  Database["public"]["Tables"]["org_api_tokens"]["Row"];

/**
 * A row from the `fn_list_visible_users` RPC — the joined return shape over
 * auth.users × user_profiles × user_roles. Defined in migration 00046
 * (replaces the prior `user_directory` VIEW for #269 to clear two CRITICAL
 * Supabase linter ERRORs: `auth_users_exposed` + `security_definer_view`).
 *
 * The RPC is SECURITY DEFINER and enforces visibility via the
 * `user_can_see_user_profile(user_id)` helper (same predicate the old view
 * used in its WHERE clause).
 *
 * We explicitly NULL-widen every column here. The Supabase codegen does not
 * carry column nullability through function return-types (the underlying
 * pg_type metadata only marks columns NOT NULL when the function declares
 * STRICT or the column has a default — neither applies to TABLE-returning
 * SECURITY DEFINER functions). At runtime every column EXCEPT `user_id`
 * may be NULL because the joins are LEFT JOINs onto user_profiles and
 * user_roles: a user with no profile or no role row surfaces with NULL
 * columns, identical to the prior view's Row shape.
 *
 * `UserDirectoryRow` is kept as a deprecated alias so existing import sites
 * still compile during the codebase rollover. New code should import
 * `UserVisibleRow` directly.
 */
type RawFnListVisibleUsersRow =
  Database["public"]["Functions"]["fn_list_visible_users"]["Returns"][number];

export type UserVisibleRow = {
  [K in keyof RawFnListVisibleUsersRow]: RawFnListVisibleUsersRow[K] | null;
};

/** @deprecated Use `UserVisibleRow` — kept for one PR cycle of backwards compat. */
export type UserDirectoryRow = UserVisibleRow;

// ── Views ─────────────────────────────────────────────────────────────────────

/** Row from the microgrid_recent_activity VIEW (migration 00011). */
export type MicrogridRecentActivityRow =
  Database["public"]["Views"]["microgrid_recent_activity"]["Row"];

// ── Enum runtime values ───────────────────────────────────────────────────────

/** Runtime tuple of all valid microgrid_ems_type enum values (Postgres enum order). */
export const MICROGRID_EMS_TYPE_VALUES = Constants.public.Enums.microgrid_ems_type;

// ── Enums (literal-union types) ───────────────────────────────────────────────

export type UserRole = Database["public"]["Enums"]["user_role"];
export type RoleScopeType = Database["public"]["Enums"]["role_scope_type"];
/**
 * Microgrid-level OpenEMS backend type. Introduced in #101 when OpenEMS became
 * the only supported edge-data source; the former `edge_data_source` enum
 * (openems / modbus_direct / mqtt / rest_api) was dropped.
 */
export type MicrogridEmsType = Database["public"]["Enums"]["microgrid_ems_type"];
export type DeviceType = Database["public"]["Enums"]["device_type"];
export type HouseholdDeviceRole =
  Database["public"]["Enums"]["household_device_role"];
export type BillingPeriodStatus =
  Database["public"]["Enums"]["billing_period_status"];

/** Payment status for a single billing_line_items row. Mirrors the
 *  `billing_line_item_payment_status` Postgres enum (migration 00021).
 *  Keep in sync with `src/lib/payments/state.ts` PaymentStatus type. */
export type BillingLineItemPaymentStatus =
  Database["public"]["Enums"]["billing_line_item_payment_status"];

/** Provenance of a billing_line_items row's reading. Mirrors the
 *  `billing_line_item_reading_source` Postgres enum (migration 00029, BC1). */
export type ReadingSource =
  Database["public"]["Enums"]["billing_line_item_reading_source"];

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
