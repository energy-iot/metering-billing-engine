import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { BillingPeriod, BillingLineItem, Edge } from "@/lib/types/domain";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import type { OpenEmsClientConfig } from "@/lib/openems";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { Banner } from "@/components/ui/banner";
import {
  EdgeHealthStrip,
  resolveEdgeStatus,
  type EdgeHealthEntry,
  type EdgeStatusMap,
} from "@/components/dashboard/EdgeHealthStrip";
import { OpenPeriodSummary } from "@/components/dashboard/OpenPeriodSummary";
import { TopHouseholdsLeaderboard, type LeaderboardEntry } from "@/components/dashboard/TopHouseholdsLeaderboard";
import { ConsumptionCalendarWidget } from "@/components/dashboard/ConsumptionCalendarWidget";
import { ActivityLog, type ActivityEvent } from "@/components/dashboard/ActivityLog";
import { DeleteEntityButton } from "@/components/forms/DeleteEntityButton";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { dayKeyInZone, addDaysToDateKey } from "@/lib/timezone/day-key";

// Microgrid Dashboard landing (D2 / #53, UX1a / #72, UX1b / #73).
//
// #72 adds the edge-health strip + offline alert.
// #73 adds insight widgets below the strip:
//   - Open-period summary strip (5 cells + projected total)
//   - Top-3 households leaderboard
//   - 30-day consumption calendar (OpenEMS energy data)
//   - Recent activity log (from microgrid_recent_activity VIEW)
//
// All data fetching is server-side. Client components receive serializable props.
// Query budget (this ticket): ≤ 4 Supabase queries + 1 OpenEMS energy call (+ 1 from #72).

type EdgeRow = Pick<Edge, "id" | "name" | "openems_edge_id">;

type EdgeWithDevices = EdgeRow & {
  devices?: { id: string; openems_component_id: string | null }[];
};

type LineItemRow = Pick<BillingLineItem, "id" | "billing_period_id" | "household_id" | "usage_kwh" | "total_amount">;

type HouseholdRow = { id: string; display_name: string; microgrid_id: string };

type ActivityRow = {
  microgrid_id: string | null;
  kind: string | null;
  timestamp: string | null;
  description: string | null;
};

// ── Edge status helpers (preserved from #72) ───────────────────────────────

async function fetchEdgeStatusMap(
  emsConfig: OpenEmsClientConfig | null,
  openemsEdgeIds: string[],
): Promise<{ map: EdgeStatusMap; unreachable: boolean; error: string | null }> {
  if (openemsEdgeIds.length === 0) {
    return { map: {}, unreachable: false, error: null };
  }
  if (!emsConfig) {
    return {
      map: null,
      unreachable: true,
      error: "OpenEMS Backend not configured for this microgrid.",
    };
  }
  try {
    const client = createOpenEmsClient(emsConfig);
    const statuses = await client.getEdgesStatus(openemsEdgeIds);
    const map: Record<string, boolean> = {};
    for (const s of statuses) map[s.edgeId] = s.online;
    return { map, unreachable: false, error: null };
  } catch (err) {
    const message =
      err instanceof OpenEmsError
        ? err.message
        : "Edge status could not be fetched from OpenEMS";
    return { map: null, unreachable: true, error: message };
  }
}

// ── Daily energy from OpenEMS (30-day window for calendar) ─────────────────

async function fetchDailyEnergyByDate(
  emsConfig: OpenEmsClientConfig | null,
  openemsEdges: { openems_edge_id: string; devices: { openems_component_id: string | null }[] }[],
  fromDate: string,
  toDate: string,
  timezone: string,
): Promise<Record<string, number>> {
  if (openemsEdges.length === 0) return {};
  if (!emsConfig) return {};

  try {
    const client = createOpenEmsClient(emsConfig);
    const byDate: Record<string, number> = {};

    // Single call per edge (all channels for that edge), then aggregate across edges
    await Promise.all(
      openemsEdges.map(async (edge) => {
        const channels = edge.devices
          .map((d) => d.openems_component_id)
          .filter((c): c is string => c !== null)
          .map((componentId) => `${componentId}/ActiveConsumptionEnergy`);

        if (channels.length === 0) return;

        // #359 — the zone drives BOTH the query window and the day-keys
        // (`queryDailyEnergy` bins its result keys in this zone too).
        const edgeDaily = await client.queryDailyEnergy(
          edge.openems_edge_id,
          channels,
          fromDate,
          toDate,
          timezone
        );

        for (const [date, kwh] of Object.entries(edgeDaily)) {
          byDate[date] = (byDate[date] ?? 0) + kwh;
        }
      })
    );

    return byDate;
  } catch {
    // If OpenEMS is unreachable, render calendar with all-missing days
    return {};
  }
}

// ── Page ───────────────────────────────────────────────────────────────────

export default async function MicrogridDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  // ── Microgrid metadata + access check (for Delete button, AC-UI-2) ──────
  const [{ data: microgridData }, canManage] = await Promise.all([
    supabase.from("microgrids").select("id, name, timezone").eq("id", id).single(),
    currentUserCanAccessMicrogrid(supabase, id),
  ]);

  // ── Query 1: Edges (+ devices for OpenEMS channels) ─────────────────────
  const { data: edgesRaw } = await supabase
    .from("edges")
    .select("id, name, openems_edge_id, devices(id, openems_component_id)")
    .eq("microgrid_id", id)
    .returns<(EdgeRow & { devices: { id: string; openems_component_id: string | null }[] })[]>();

  const allEdgesRaw = edgesRaw ?? [];

  // ── Query 2: Open draft billing period + line items ──────────────────────
  const { data: openPeriods } = await supabase
    .from("billing_periods")
    .select("*")
    .eq("microgrid_id", id)
    .eq("status", "draft")
    .order("start_date", { ascending: false })
    .limit(1)
    .returns<BillingPeriod[]>();

  const draft = openPeriods?.[0] ?? null;

  // ── Query 3: Line items for open period + households (combined) ──────────
  let lineItems: LineItemRow[] = [];
  let households: HouseholdRow[] = [];

  if (draft) {
    const [lineItemsResult, householdsResult] = await Promise.all([
      supabase
        .from("billing_line_items")
        .select("id, billing_period_id, household_id, usage_kwh, total_amount")
        .eq("billing_period_id", draft.id)
        .returns<LineItemRow[]>(),
      supabase
        .from("households")
        .select("id, display_name, microgrid_id")
        .eq("microgrid_id", id)
        .returns<HouseholdRow[]>(),
    ]);
    lineItems = lineItemsResult.data ?? [];
    households = householdsResult.data ?? [];
  }

  // ── Query 4: Previous closed period line items (for calendar target) ─────
  let prevPeriodLineItems: LineItemRow[] = [];
  let prevPeriodDays = 0;

  const { data: prevPeriods } = await supabase
    .from("billing_periods")
    .select("*")
    .eq("microgrid_id", id)
    .eq("status", "closed")
    .order("end_date", { ascending: false })
    .limit(1)
    .returns<BillingPeriod[]>();

  const prevPeriod = prevPeriods?.[0] ?? null;

  if (prevPeriod) {
    prevPeriodDays =
      Math.round(
        (new Date(prevPeriod.end_date).getTime() -
          new Date(prevPeriod.start_date).getTime()) /
          (1000 * 60 * 60 * 24)
      ) + 1;

    const { data: prevLineItemsData } = await supabase
      .from("billing_line_items")
      .select("id, billing_period_id, household_id, usage_kwh, total_amount")
      .eq("billing_period_id", prevPeriod.id)
      .returns<LineItemRow[]>();

    prevPeriodLineItems = prevLineItemsData ?? [];
  }

  // ── Query 5 (VIEW): Recent activity log ─────────────────────────────────
  const { data: activityRaw } = await supabase
    .from("microgrid_recent_activity")
    .select("microgrid_id, kind, timestamp, description")
    .eq("microgrid_id", id)
    .limit(10)
    .returns<ActivityRow[]>();

  const activityEvents: ActivityEvent[] = (activityRaw ?? [])
    .filter((r): r is ActivityRow & { kind: string; timestamp: string; description: string } =>
      r.kind !== null && r.timestamp !== null && r.description !== null
    )
    .map((r) => ({
      kind: r.kind,
      timestamp: r.timestamp,
      description: r.description,
    }));

  // ── Hierarchy breadcrumb ─────────────────────────────────────────────────
  const levels = await getHierarchyLevels(supabase, { kind: "microgrid", microgridId: id });

  // ── Resolve edge health (from #72) ────────────────────────────────────────
  // Post-#101: every edge is OpenEMS (the only supported type).
  const allEdges: EdgeHealthEntry[] = allEdgesRaw.map((e) => ({
    id: e.id,
    name: e.name,
    openems_edge_id: e.openems_edge_id,
  }));

  const openemsEdgeIds = allEdges
    .filter((e) => !!e.openems_edge_id)
    .map((e) => e.openems_edge_id as string);

  // Resolve microgrid-level OpenEMS config. Silent-null on error so the page
  // still renders (strips fall back to "unknown" health chips + "unreachable"
  // banner when openemsEdgeIds are present).
  let emsConfig: OpenEmsClientConfig | null = null;
  try {
    emsConfig = await getMicrogridEmsConfig(supabase, id);
  } catch {
    emsConfig = null;
  }

  const { map: edgeStatusMap, unreachable, error: statusError } =
    await fetchEdgeStatusMap(emsConfig, openemsEdgeIds);

  // ── Daily energy for calendar ────────────────────────────────────────────
  // #359 — live-vs-stamped split (tz-awareness anchor #353). The 30-day
  // strip overlays two sources on one day-axis, so the axis' day-BINNING
  // (not just the query window) is zone-aware:
  //   - the live/open portion buckets by the live `microgrids.timezone`;
  //   - days inside the previous CLOSED period bucket by that period's
  //     immutable `billing_periods.timezone` stamp, so the cells agree
  //     with that period's own bill after a zone change.
  // The zone is a windowing/binning input for the ENERGY DATA only — it
  // never reinterprets a period's plain-DATE start/end for display.
  const liveTz = microgridData?.timezone ?? "UTC";
  const stampedTz = prevPeriod?.timezone ?? liveTz;

  const today = new Date();
  // "Today" as the operator's microgrid calendar sees it — a UTC slice
  // would already be tomorrow (or still yesterday) for non-UTC zones.
  const toDateStr = dayKeyInZone(today, liveTz);
  const fromDateStr = addDaysToDateKey(toDateStr, -29); // 30 days incl. today

  // Build window of 30 date strings for the calendar (plain consecutive
  // calendar dates — identical labels in every zone once anchored).
  const windowDates: string[] = [];
  for (let i = 0; i < 30; i++) {
    windowDates.push(addDaysToDateKey(fromDateStr, i));
  }

  const openemsEdgesWithDevices = allEdgesRaw
    .filter((e) => !!e.openems_edge_id)
    .map((e) => ({
      openems_edge_id: e.openems_edge_id as string,
      devices: (e as EdgeWithDevices).devices ?? [],
    }));

  // Boundary between the closed-period portion (stamped zone) and the
  // live portion (live zone). Only materializes when the zones actually
  // differ AND the closed period reaches into the window — otherwise one
  // query in the live zone covers the whole strip.
  let energyByDate: Record<string, number>;
  let zoneBoundary: {
    lastStampedDate: string;
    stampedTz: string;
    liveTz: string;
  } | null = null;

  if (
    prevPeriod &&
    stampedTz !== liveTz &&
    prevPeriod.end_date >= fromDateStr
  ) {
    const closedTo =
      prevPeriod.end_date < toDateStr ? prevPeriod.end_date : toDateStr;
    const [closedPart, livePart] = await Promise.all([
      fetchDailyEnergyByDate(
        emsConfig,
        openemsEdgesWithDevices,
        fromDateStr,
        closedTo,
        stampedTz
      ),
      closedTo < toDateStr
        ? fetchDailyEnergyByDate(
            emsConfig,
            openemsEdgesWithDevices,
            addDaysToDateKey(closedTo, 1),
            toDateStr,
            liveTz
          )
        : Promise.resolve<Record<string, number>>({}),
    ]);
    // Each portion owns its side of the boundary — a stray key from one
    // query never overwrites a cell the other zone governs.
    energyByDate = {};
    for (const [date, kwh] of Object.entries(closedPart)) {
      if (date <= closedTo) energyByDate[date] = kwh;
    }
    for (const [date, kwh] of Object.entries(livePart)) {
      if (date > closedTo) energyByDate[date] = kwh;
    }
    // Annotate the zone change on the axis (Architect guardrail: mark
    // it, never re-bin a period to a uniform zone to hide it).
    zoneBoundary = { lastStampedDate: closedTo, stampedTz, liveTz };
  } else {
    energyByDate = await fetchDailyEnergyByDate(
      emsConfig,
      openemsEdgesWithDevices,
      fromDateStr,
      toDateStr,
      liveTz
    );
  }

  // ── Compute open-period summary ──────────────────────────────────────────
  const billingHref = draft
    ? `/microgrids/${id}/billing/${draft.id}`
    : `/microgrids/${id}/billing`;

  let openPeriodSummaryProps: React.ComponentProps<typeof OpenPeriodSummary>["period"] = null;

  if (draft) {
    const start = new Date(draft.start_date);
    const end = new Date(draft.end_date);
    const periodDays =
      Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    const elapsedDays = Math.max(
      1,
      Math.round((today.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1
    );

    const totalUsageKwh = lineItems.reduce((s, li) => s + (li.usage_kwh ?? 0), 0);
    const totalAmount = lineItems.reduce((s, li) => s + (li.total_amount ?? 0), 0);

    // PROJECTED TOTAL FORMULA:
    //   projected_kwh = running_usage_kwh * (period_days / elapsed_days)
    //   projected_amount = running_amount * (period_days / elapsed_days)
    //   elapsed_days is floored at 1 to avoid division by zero.
    const projectionMultiplier = periodDays / elapsedDays;
    const projectedUsageKwh = totalUsageKwh * projectionMultiplier;
    const projectedAmount = totalAmount * projectionMultiplier;

    openPeriodSummaryProps = {
      id: draft.id,
      start_date: draft.start_date,
      end_date: draft.end_date,
      householdsCount: households.length,
      totalUsageKwh,
      totalAmount,
      projectedUsageKwh,
      projectedAmount,
    };
  }

  // ── Compute top-3 leaderboard ────────────────────────────────────────────
  const householdMap = new Map(households.map((h) => [h.id, h.display_name]));

  const leaderboardEntries: LeaderboardEntry[] = lineItems
    .map((li) => ({
      householdId: li.household_id,
      householdName: householdMap.get(li.household_id) ?? "Unknown",
      usageKwh: li.usage_kwh ?? 0,
      totalAmount: li.total_amount ?? 0,
    }))
    .sort((a, b) => b.usageKwh - a.usageKwh)
    .slice(0, 3);

  const microgridTotalKwh = lineItems.reduce((s, li) => s + (li.usage_kwh ?? 0), 0);

  // ── Compute calendar target ──────────────────────────────────────────────
  // TARGET FORMULA:
  //   target_daily_kwh = sum(prev period line items usage_kwh) / period_day_count
  //   Fallback to null (mode="absolute") when:
  //     - prevPeriodDays < 7, OR
  //     - prevPeriodLineItems is empty (no data)
  let targetDailyKwh: number | null = null;

  if (prevPeriodDays >= 7 && prevPeriodLineItems.length > 0) {
    const prevTotal = prevPeriodLineItems.reduce((s, li) => s + (li.usage_kwh ?? 0), 0);
    if (prevTotal > 0) {
      targetDailyKwh = prevTotal / prevPeriodDays;
    }
  }

  // ── Banner logic (from #72, preserved) ───────────────────────────────────
  // Post-#101: every edge is OpenEMS; no data_source_type filter needed.
  const offlineEdges = allEdges.filter((edge) => {
    const status = resolveEdgeStatus(edge, edgeStatusMap);
    return status === "offline" || (unreachable && status === "unknown");
  });

  const showUnreachableBanner = unreachable && openemsEdgeIds.length > 0;
  const showOfflineBanner = !unreachable && offlineEdges.length > 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <HierarchyNav levels={levels} className="mb-2" />
        {canManage && microgridData && (
          <DeleteEntityButton
            entity="microgrid"
            id={microgridData.id}
            name={microgridData.name}
          />
        )}
      </div>

      {/* ── Empty state ─────────────────────────────────────────────────── */}
      {allEdges.length === 0 && (
        <Banner
          tone="info"
          title="No edges configured"
          action={
            <Link
              href={`/microgrids/${id}/setup/edges`}
              className="text-sm font-medium underline hover:opacity-80"
            >
              Go to Setup &rsaquo; Edges
            </Link>
          }
        >
          No edges have been configured for this microgrid yet.
        </Banner>
      )}

      {/* ── OpenEMS unreachable banner ───────────────────────────────────── */}
      {showUnreachableBanner && (
        <Banner
          tone="destructive"
          title="Edge unreachable"
          action={
            <Link
              href={`/microgrids/${id}/setup/edges`}
              className="text-sm font-medium underline hover:opacity-80"
            >
              View edges in Setup
            </Link>
          }
        >
          {statusError ??
            "Edge status could not be fetched from OpenEMS. Check that the OpenEMS backend is reachable."}
        </Banner>
      )}

      {/* ── Offline banner (one banner, bulleted list of offline edges) ─── */}
      {showOfflineBanner && (
        <Banner
          tone="destructive"
          title="Edge offline"
          action={
            <Link
              href={`/microgrids/${id}/setup/edges`}
              className="text-sm font-medium underline hover:opacity-80"
            >
              View edges in Setup
            </Link>
          }
        >
          {offlineEdges.length === 1 ? (
            <p>
              <Link
                href={`/microgrids/${id}/setup/edges/${offlineEdges[0].id}/`}
                className="font-medium underline hover:opacity-80"
              >
                {offlineEdges[0].name}
              </Link>{" "}
              has not reported a reading.
            </p>
          ) : (
            <ul className="ml-4 list-disc space-y-0.5">
              {offlineEdges.map((edge) => (
                <li key={edge.id}>
                  <Link
                    href={`/microgrids/${id}/setup/edges/${edge.id}/`}
                    className="font-medium underline hover:opacity-80"
                  >
                    {edge.name}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Banner>
      )}

      {/* ── Edge health strip ────────────────────────────────────────────── */}
      {allEdges.length > 0 && (
        <section
          aria-label="Edge health"
          className="rounded-lg border border-border bg-card px-4 py-3"
        >
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Edges
          </p>
          <EdgeHealthStrip
            microgridId={id}
            edges={allEdges}
            edgeStatusMap={edgeStatusMap}
          />
        </section>
      )}

      {/* ── Insight widgets (UX1b / #73) ─────────────────────────────────── */}

      {/* Open period summary strip */}
      <OpenPeriodSummary microgridId={id} period={openPeriodSummaryProps} />

      {/* Two-column layout: leaderboard + calendar */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Top-3 households leaderboard (only shown when period exists) */}
        {draft && (
          <TopHouseholdsLeaderboard
            entries={leaderboardEntries}
            microgridTotalKwh={microgridTotalKwh}
          />
        )}

        {/* 30-day consumption calendar */}
        <ConsumptionCalendarWidget
          windowDates={windowDates}
          energyByDate={energyByDate}
          targetDailyKwh={targetDailyKwh}
          todayDate={toDateStr}
          zoneBoundary={zoneBoundary}
        />
      </div>

      {/* Activity log */}
      <ActivityLog events={activityEvents} />

      {/* Quick-action billing link (preserved from original placeholder) */}
      <section className="rounded-lg border border-border bg-card p-4">
        <div>
          <Link
            href={billingHref}
            className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
          >
            {draft ? "Open draft period" : "Go to Billing"} →
          </Link>
        </div>
      </section>
    </div>
  );
}
