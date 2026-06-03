import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type {
  BillingLineItem,
  BillingPeriod,
  Household,
  Microgrid,
  RateSchedule,
} from "@/lib/types/domain";
import { BillingTable } from "@/components/BillingTable";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";

export default async function BillingPeriodDetailPage({
  params,
}: {
  params: Promise<{ id: string; periodId: string }>;
}) {
  const { id, periodId } = await params;
  const supabase = await createClient();

  const levels = await getHierarchyLevels(supabase, {
    kind: "microgrid",
    microgridId: id,
  });

  type MicrogridWithCommunity = Microgrid & {
    communities: { id: string; payment_provider: string | null } | null;
  };

  // BC2 (#174) — type for the household-edge join used to compute
  // `edgeAvailableByHouseholdId`. Mirrors the SELECT chain in
  // `src/lib/billing/generate.ts:251-264`.
  type HouseholdEdgeRow = {
    id: string;
    household_devices: Array<{
      role: string;
      devices: {
        openems_component_id: string | null;
        edges: { openems_edge_id: string | null } | null;
      } | null;
    }>;
  };

  const [
    { data: period, error: periodError },
    { data: lineItems, error: lineItemsError },
    { data: households, error: householdsError },
    { data: householdEdges, error: householdEdgesError },
    { data: schedule, error: scheduleError },
    { data: microgrid, error: microgridError },
    isSuperAdmin,
  ] = await Promise.all([
    supabase
      .from("billing_periods")
      .select("*")
      .eq("id", periodId)
      .eq("microgrid_id", id)
      .single()
      .then((res) => ({ ...res, data: res.data as BillingPeriod | null })),
    // BC2 (#174) — line items without the actor join. The
    // `user_directory!entered_by_user_id(...)` PostgREST shorthand was
    // dropped when the underlying view was replaced by the
    // `fn_list_visible_users` RPC in #269 (no FK metadata on a function).
    // We resolve the actor display name in a second step below using
    // the same RPC, batched on the collected entered_by_user_id set.
    supabase
      .from("billing_line_items")
      .select(
        "*, payment_status, paid_at, paid_by_user_id, payment_notes",
      )
      .eq("billing_period_id", periodId)
      .returns<BillingLineItem[]>(),
    supabase
      .from("households")
      .select("*")
      .eq("microgrid_id", id)
      .order("display_name")
      .returns<Household[]>(),
    supabase
      .from("households")
      .select(
        `id,
         household_devices(
           role,
           devices(
             openems_component_id,
             edges(openems_edge_id)
           )
         )`,
      )
      .eq("microgrid_id", id)
      .eq("household_devices.role", "primary_consumption_meter")
      .returns<HouseholdEdgeRow[]>(),
    supabase
      .from("rate_schedules")
      .select("*")
      .eq("microgrid_id", id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
      .then((res) => ({ ...res, data: res.data as RateSchedule | null })),
    supabase
      .from("microgrids")
      .select("id, name, currency, communities!inner(id, payment_provider)")
      .eq("id", id)
      .single()
      .then((res) => ({ ...res, data: res.data as MicrogridWithCommunity | null })),
    currentUserIsSuperAdmin(supabase),
  ]);

  if (periodError || !period) {
    notFound();
  }

  if (microgridError || !microgrid) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading microgrid: {microgridError?.message ?? "Not found"}
      </div>
    );
  }

  if (householdsError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading households: {householdsError.message}
      </div>
    );
  }

  if (lineItemsError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading line items: {lineItemsError.message}
      </div>
    );
  }

  if (scheduleError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading rate schedule: {scheduleError.message}
      </div>
    );
  }

  // BC2 (#174) — surface the household-edge fetch error if it occurred.
  // Defensive: failure here only suppresses the "Switch back to edge data"
  // / "Regenerate from edge data" items in the kebab; the rest of the
  // table still renders. Log silently and fall back to an empty map.
  if (householdEdgesError) {
    console.warn(
      "[BillingPeriodDetailPage] household-edge fetch failed:",
      householdEdgesError.message,
    );
  }

  // Normalize PostgREST join (may be array or single object)
  const community = microgrid.communities
    ? Array.isArray(microgrid.communities)
      ? (microgrid.communities as { id: string; payment_provider: string | null }[])[0]
      : (microgrid.communities as { id: string; payment_provider: string | null })
    : null;

  const isPaymentConfigured = community?.payment_provider != null;
  const communityId = community?.id;

  // BC2 (#174) — compute edgeAvailable per household. Mirrors the gate
  // in `runGenerationFor` (src/lib/billing/generate.ts:289-311):
  // available iff a primary_consumption_meter device exists AND its
  // edge.openems_edge_id AND device.openems_component_id are non-null.
  const edgeAvailableByHouseholdId: Record<string, boolean> = {};
  for (const row of householdEdges ?? []) {
    const primaryHD = row.household_devices.find(
      (hd) => hd.role === "primary_consumption_meter",
    );
    const device = primaryHD?.devices ?? null;
    const edge = device?.edges ?? null;
    edgeAvailableByHouseholdId[row.id] =
      device != null &&
      device.openems_component_id != null &&
      edge != null &&
      edge.openems_edge_id != null;
  }

  // BC2 (#174) — resolve the actor display name per line item via a
  // second call to the `fn_list_visible_users` RPC (#269 replaced the
  // user_directory view). Collect the entered_by_user_id set, ask the
  // RPC for those rows in one batch, then index by user id and build
  // the actor map. RLS-hidden actors (e.g. super_admin invisible to an
  // org_manager caller) simply don't appear in the response → null
  // entry, matching the previous LEFT-JOIN-miss semantics.
  const cleanLineItems = (lineItems ?? []) as BillingLineItem[];
  const enteredByIds = Array.from(
    new Set(
      cleanLineItems
        .map((li) => li.entered_by_user_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  );

  const actorById = new Map<
    string,
    { first_name: string | null; last_name: string | null; email: string | null }
  >();
  if (enteredByIds.length > 0) {
    const { data: actorRows } = await supabase.rpc("fn_list_visible_users", {
      _target_user_ids: enteredByIds,
    });
    for (const r of actorRows ?? []) {
      if (!r.user_id) continue;
      actorById.set(r.user_id, {
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
      });
    }
  }

  const actorByLineItemId: Record<string, string | null> = {};
  for (const li of cleanLineItems) {
    // Mirror `pickDisplayName` from src/lib/billing/audit-log-fetch.ts:75-82:
    // first_name + last_name (joined with a space), fallback to email,
    // fallback to null.
    const enteredBy = li.entered_by_user_id;
    const row = enteredBy ? actorById.get(enteredBy) ?? null : null;
    const parts = [row?.first_name, row?.last_name].filter(
      (s): s is string => typeof s === "string" && s.length > 0,
    );
    actorByLineItemId[li.id] =
      parts.length > 0 ? parts.join(" ") : (row?.email ?? null);
  }

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />
      <BillingTable
        microgridId={id}
        period={period}
        lineItems={cleanLineItems}
        households={households ?? []}
        tiers={(schedule?.tiers ?? []) as { label: string; min_kwh: number; max_kwh: number | null; rate_per_kwh: number }[]}
        currency={microgrid.currency}
        isPaymentConfigured={isPaymentConfigured}
        isSuperAdmin={isSuperAdmin}
        communityId={communityId}
        edgeAvailableByHouseholdId={edgeAvailableByHouseholdId}
        actorByLineItemId={actorByLineItemId}
      />
    </>
  );
}
