/**
 * entity-descendants-types.ts — client-safe types + pure helpers for the
 * entity-deletion flow (#89).
 *
 * Split from `entity-descendants.ts` (which imports `server-only`) so that
 * client components (e.g. `<BlastRadiusList>`, `<DeleteEntityButton>`) can
 * consume the `DescendantCounts` type and the pure emptiness check without
 * pulling the server-only Supabase query logic into the client bundle.
 *
 * DO NOT put any Supabase-touching code here — add it to
 * `entity-descendants.ts` instead.
 */

export type EntityKind = "organization" | "community" | "microgrid" | "edge";

export type DescendantCounts =
  | {
      kind: "organization";
      communities: number;
      microgrids: number;
      edges: number;
      devices: number;
      households: number;
      household_devices: number;
      household_users: number;
      billing_periods_draft: number;
      billing_periods_closed: number;
      billing_line_items: number;
      rate_schedules: number;
      user_roles: number;
    }
  | {
      kind: "community";
      microgrids: number;
      edges: number;
      devices: number;
      households: number;
      household_devices: number;
      household_users: number;
      billing_periods_draft: number;
      billing_periods_closed: number;
      billing_line_items: number;
      rate_schedules: number;
    }
  | {
      kind: "microgrid";
      edges: number;
      devices: number;
      households: number;
      household_devices: number;
      household_users: number;
      billing_periods_draft: number;
      billing_periods_closed: number;
      billing_line_items: number;
      rate_schedules: number;
    }
  | {
      kind: "edge";
      devices: number;
      household_devices: number;
      /**
       * Billing line items whose `device_id` will be SET NULL (NOT deleted)
       * by cascading the edge → device chain. Historical billing rows
       * survive per schema design (00001_schema.sql:241).
       */
      billing_line_items_nulled: number;
    };

/**
 * True iff every descendant field on the given counts object is zero.
 * Used by the dialog body to render a single "no descendants" line
 * instead of a row of zeros (AC-UI-4 empty-entity case).
 */
export function descendantCountsAreEmpty(counts: DescendantCounts): boolean {
  switch (counts.kind) {
    case "organization":
      return (
        counts.communities === 0 &&
        counts.microgrids === 0 &&
        counts.edges === 0 &&
        counts.devices === 0 &&
        counts.households === 0 &&
        counts.household_devices === 0 &&
        counts.household_users === 0 &&
        counts.billing_periods_draft === 0 &&
        counts.billing_periods_closed === 0 &&
        counts.billing_line_items === 0 &&
        counts.rate_schedules === 0 &&
        counts.user_roles === 0
      );
    case "community":
      return (
        counts.microgrids === 0 &&
        counts.edges === 0 &&
        counts.devices === 0 &&
        counts.households === 0 &&
        counts.household_devices === 0 &&
        counts.household_users === 0 &&
        counts.billing_periods_draft === 0 &&
        counts.billing_periods_closed === 0 &&
        counts.billing_line_items === 0 &&
        counts.rate_schedules === 0
      );
    case "microgrid":
      return (
        counts.edges === 0 &&
        counts.devices === 0 &&
        counts.households === 0 &&
        counts.household_devices === 0 &&
        counts.household_users === 0 &&
        counts.billing_periods_draft === 0 &&
        counts.billing_periods_closed === 0 &&
        counts.billing_line_items === 0 &&
        counts.rate_schedules === 0
      );
    case "edge":
      return (
        counts.devices === 0 &&
        counts.household_devices === 0 &&
        counts.billing_line_items_nulled === 0
      );
  }
}
