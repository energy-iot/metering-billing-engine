import "server-only";

/**
 * entity-descendants.ts — shared descendant counter for the entity-deletion
 * flow (#89). Single source of truth used by:
 *
 *   - the `GET /api/{organizations|communities|microgrids|edges}/[id]/delete-preview`
 *     endpoints that feed the blast-radius dialog, and
 *   - the corresponding DELETE routes' structured log payload (AC-LOG-1).
 *
 * Design:
 *   * Each query uses `count: "exact", head: true` so we count without
 *     transferring rows. Counts run in parallel via `Promise.all` — one
 *     "round-trip" per descendant kind is acceptable at pilot scale
 *     (<200ms aggregate per AC-ROUTE-6 budget). Chose this over a single
 *     Postgres RPC so the counts honor RLS on the caller's Supabase
 *     client — no separate privilege surface to audit.
 *
 *   * Return type is a discriminated union keyed on `kind`, so call sites
 *     narrow correctly in TypeScript and the dialog copy can render the
 *     right labels per entity kind.
 *
 *   * For an `edge` delete, `billing_line_items_nulled` is the count of
 *     rows whose `device_id` points at a device under this edge — these
 *     rows SURVIVE the cascade (FK is ON DELETE SET NULL per
 *     00001_schema.sql:241, intentional to preserve historical bills).
 *     The UI surfaces this as a "loses device linkage" line, NOT a
 *     destroyed-count. See AC-FK-AUDIT.
 *
 *   * For `edge.household_devices`: devices cascade-delete household_devices
 *     rows per 00001_schema.sql:191, so this count represents meter↔household
 *     links that will be severed (the households themselves survive since
 *     they hang off `microgrid_id`, not edge).
 *
 *   * Billing periods are split into `billing_periods_draft` and
 *     `billing_periods_closed` (NOT a single total) so the dialog copy
 *     can surface the "draft = unfinalized work lost" case distinctly
 *     per AC-ROUTE-8. Enum values are `'draft'` and `'closed'` — the
 *     `billing_period_status` enum has no other values (see
 *     00001_schema.sql:49). Never use the word `'open'`.
 *
 *   * `user_roles` counts (org-scoped only) rely on the FK+CASCADE from
 *     00015_entity_deletion_safeguards.sql; we filter by `scope_type='org'
 *     AND scope_id=<org_id>` which matches exactly the rows that will be
 *     cascade-deleted.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

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
       * survive per schema design (00001_schema.sql:241) — the dialog
       * surfaces this as a "loses linkage" line, not "destroyed."
       */
      billing_line_items_nulled: number;
    };

/** Convert a Supabase `count: "exact", head: true` result to a number. */
function n(count: number | null | undefined): number {
  return count ?? 0;
}

async function countTable(
  supabase: SupabaseClient,
  table: string,
  filter: { column: string; values: string[] }
): Promise<number> {
  if (filter.values.length === 0) return 0;
  const query = supabase.from(table).select("id", { count: "exact", head: true });
  const { count } = await (filter.values.length === 1
    ? query.eq(filter.column, filter.values[0])
    : query.in(filter.column, filter.values));
  return n(count);
}

async function countTableWith(
  supabase: SupabaseClient,
  table: string,
  apply: (qb: ReturnType<SupabaseClient["from"]>) => unknown
): Promise<number> {
  const qb = supabase.from(table).select("id", { count: "exact", head: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (await apply(qb as any)) as { count: number | null };
  return n(res.count);
}

// ── Per-entity counters ──────────────────────────────────────────────────

async function countForOrganization(
  supabase: SupabaseClient,
  orgId: string
): Promise<Extract<DescendantCounts, { kind: "organization" }>> {
  // Resolve the descendant-id trees once; subsequent counts reuse them.
  const { data: communities } = await supabase
    .from("communities")
    .select("id")
    .eq("org_id", orgId);
  const communityIds = (communities ?? []).map((r) => r.id as string);

  const { data: microgrids } = communityIds.length
    ? await supabase.from("microgrids").select("id").in("community_id", communityIds)
    : { data: [] as { id: string }[] };
  const microgridIds = (microgrids ?? []).map((r) => r.id as string);

  const { data: edges } = microgridIds.length
    ? await supabase.from("edges").select("id").in("microgrid_id", microgridIds)
    : { data: [] as { id: string }[] };
  const edgeIds = (edges ?? []).map((r) => r.id as string);

  const { data: devices } = edgeIds.length
    ? await supabase.from("devices").select("id").in("edge_id", edgeIds)
    : { data: [] as { id: string }[] };
  const deviceIds = (devices ?? []).map((r) => r.id as string);

  const { data: households } = microgridIds.length
    ? await supabase.from("households").select("id").in("microgrid_id", microgridIds)
    : { data: [] as { id: string }[] };
  const householdIds = (households ?? []).map((r) => r.id as string);

  const { data: billingPeriods } = microgridIds.length
    ? await supabase
        .from("billing_periods")
        .select("id,status")
        .in("microgrid_id", microgridIds)
    : { data: [] as { id: string; status: string }[] };
  const billingPeriodIds = (billingPeriods ?? []).map((r) => r.id as string);
  const bpDraft = (billingPeriods ?? []).filter((r) => r.status === "draft").length;
  const bpClosed = (billingPeriods ?? []).filter((r) => r.status === "closed").length;

  const [
    householdDevicesCount,
    householdUsersCount,
    billingLineItemsCount,
    rateSchedulesCount,
    userRolesCount,
  ] = await Promise.all([
    householdIds.length
      ? countTable(supabase, "household_devices", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    householdIds.length
      ? countTable(supabase, "household_users", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    billingPeriodIds.length
      ? countTable(supabase, "billing_line_items", {
          column: "billing_period_id",
          values: billingPeriodIds,
        })
      : Promise.resolve(0),
    microgridIds.length
      ? countTable(supabase, "rate_schedules", {
          column: "microgrid_id",
          values: microgridIds,
        })
      : Promise.resolve(0),
    countTableWith(supabase, "user_roles", (qb) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (qb as any).eq("scope_type", "org").eq("scope_id", orgId)
    ),
  ]);

  return {
    kind: "organization",
    communities: communityIds.length,
    microgrids: microgridIds.length,
    edges: edgeIds.length,
    devices: deviceIds.length,
    households: householdIds.length,
    household_devices: householdDevicesCount,
    household_users: householdUsersCount,
    billing_periods_draft: bpDraft,
    billing_periods_closed: bpClosed,
    billing_line_items: billingLineItemsCount,
    rate_schedules: rateSchedulesCount,
    user_roles: userRolesCount,
  };
}

async function countForCommunity(
  supabase: SupabaseClient,
  communityId: string
): Promise<Extract<DescendantCounts, { kind: "community" }>> {
  const { data: microgrids } = await supabase
    .from("microgrids")
    .select("id")
    .eq("community_id", communityId);
  const microgridIds = (microgrids ?? []).map((r) => r.id as string);

  const { data: edges } = microgridIds.length
    ? await supabase.from("edges").select("id").in("microgrid_id", microgridIds)
    : { data: [] as { id: string }[] };
  const edgeIds = (edges ?? []).map((r) => r.id as string);

  const { data: devices } = edgeIds.length
    ? await supabase.from("devices").select("id").in("edge_id", edgeIds)
    : { data: [] as { id: string }[] };
  const deviceIds = (devices ?? []).map((r) => r.id as string);

  const { data: households } = microgridIds.length
    ? await supabase.from("households").select("id").in("microgrid_id", microgridIds)
    : { data: [] as { id: string }[] };
  const householdIds = (households ?? []).map((r) => r.id as string);

  const { data: billingPeriods } = microgridIds.length
    ? await supabase
        .from("billing_periods")
        .select("id,status")
        .in("microgrid_id", microgridIds)
    : { data: [] as { id: string; status: string }[] };
  const billingPeriodIds = (billingPeriods ?? []).map((r) => r.id as string);
  const bpDraft = (billingPeriods ?? []).filter((r) => r.status === "draft").length;
  const bpClosed = (billingPeriods ?? []).filter((r) => r.status === "closed").length;

  const [
    householdDevicesCount,
    householdUsersCount,
    billingLineItemsCount,
    rateSchedulesCount,
  ] = await Promise.all([
    householdIds.length
      ? countTable(supabase, "household_devices", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    householdIds.length
      ? countTable(supabase, "household_users", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    billingPeriodIds.length
      ? countTable(supabase, "billing_line_items", {
          column: "billing_period_id",
          values: billingPeriodIds,
        })
      : Promise.resolve(0),
    microgridIds.length
      ? countTable(supabase, "rate_schedules", {
          column: "microgrid_id",
          values: microgridIds,
        })
      : Promise.resolve(0),
  ]);

  // For this scope we count edges/devices via the resolved id trees
  // (Supabase doesn't support cross-table joins in a simple count query).
  return {
    kind: "community",
    microgrids: microgridIds.length,
    edges: edgeIds.length,
    devices: deviceIds.length,
    households: householdIds.length,
    household_devices: householdDevicesCount,
    household_users: householdUsersCount,
    billing_periods_draft: bpDraft,
    billing_periods_closed: bpClosed,
    billing_line_items: billingLineItemsCount,
    rate_schedules: rateSchedulesCount,
  };
}

async function countForMicrogrid(
  supabase: SupabaseClient,
  microgridId: string
): Promise<Extract<DescendantCounts, { kind: "microgrid" }>> {
  const { data: edges } = await supabase
    .from("edges")
    .select("id")
    .eq("microgrid_id", microgridId);
  const edgeIds = (edges ?? []).map((r) => r.id as string);

  const { data: devices } = edgeIds.length
    ? await supabase.from("devices").select("id").in("edge_id", edgeIds)
    : { data: [] as { id: string }[] };
  const deviceIds = (devices ?? []).map((r) => r.id as string);

  const { data: households } = await supabase
    .from("households")
    .select("id")
    .eq("microgrid_id", microgridId);
  const householdIds = (households ?? []).map((r) => r.id as string);

  const { data: billingPeriods } = await supabase
    .from("billing_periods")
    .select("id,status")
    .eq("microgrid_id", microgridId);
  const billingPeriodIds = (billingPeriods ?? []).map((r) => r.id as string);
  const bpDraft = (billingPeriods ?? []).filter((r) => r.status === "draft").length;
  const bpClosed = (billingPeriods ?? []).filter((r) => r.status === "closed").length;

  const [
    householdDevicesCount,
    householdUsersCount,
    billingLineItemsCount,
    rateSchedulesCount,
  ] = await Promise.all([
    householdIds.length
      ? countTable(supabase, "household_devices", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    householdIds.length
      ? countTable(supabase, "household_users", {
          column: "household_id",
          values: householdIds,
        })
      : Promise.resolve(0),
    billingPeriodIds.length
      ? countTable(supabase, "billing_line_items", {
          column: "billing_period_id",
          values: billingPeriodIds,
        })
      : Promise.resolve(0),
    countTableWith(supabase, "rate_schedules", (qb) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (qb as any).eq("microgrid_id", microgridId)
    ),
  ]);

  return {
    kind: "microgrid",
    edges: edgeIds.length,
    devices: deviceIds.length,
    households: householdIds.length,
    household_devices: householdDevicesCount,
    household_users: householdUsersCount,
    billing_periods_draft: bpDraft,
    billing_periods_closed: bpClosed,
    billing_line_items: billingLineItemsCount,
    rate_schedules: rateSchedulesCount,
  };
}

async function countForEdge(
  supabase: SupabaseClient,
  edgeId: string
): Promise<Extract<DescendantCounts, { kind: "edge" }>> {
  const { data: devices } = await supabase
    .from("devices")
    .select("id")
    .eq("edge_id", edgeId);
  const deviceIds = (devices ?? []).map((r) => r.id as string);

  const [householdDevicesCount, billingLineItemsNulled] = await Promise.all([
    deviceIds.length
      ? countTable(supabase, "household_devices", {
          column: "device_id",
          values: deviceIds,
        })
      : Promise.resolve(0),
    deviceIds.length
      ? countTable(supabase, "billing_line_items", {
          column: "device_id",
          values: deviceIds,
        })
      : Promise.resolve(0),
  ]);

  return {
    kind: "edge",
    devices: deviceIds.length,
    household_devices: householdDevicesCount,
    billing_line_items_nulled: billingLineItemsNulled,
  };
}

/**
 * Count every descendant that would be affected by a CASCADE DELETE of the
 * given entity, suitable for rendering the blast-radius dialog and for
 * logging the delete event.
 *
 * The Supabase client passed in MUST be the user-bound server client (NOT
 * service-role). Counts honor RLS — an unauthorized caller sees zeros.
 * Callers should run a permission check BEFORE this function to avoid
 * returning misleading zero counts to a legitimate caller who hit a
 * transient RLS policy regression.
 */
export async function countEntityDescendants(
  supabase: SupabaseClient,
  kind: EntityKind,
  id: string
): Promise<DescendantCounts> {
  switch (kind) {
    case "organization":
      return countForOrganization(supabase, id);
    case "community":
      return countForCommunity(supabase, id);
    case "microgrid":
      return countForMicrogrid(supabase, id);
    case "edge":
      return countForEdge(supabase, id);
  }
}

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
