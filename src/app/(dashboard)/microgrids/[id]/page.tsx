import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { BillingPeriod, Edge } from "@/lib/types/domain";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { Banner } from "@/components/ui/banner";
import {
  EdgeHealthStrip,
  resolveEdgeStatus,
  type EdgeHealthEntry,
  type EdgeStatusMap,
} from "@/components/dashboard/EdgeHealthStrip";

// Microgrid Dashboard landing (D2 / #53, UX1a / #72).
//
// #72 upgrades the placeholder edge-health chip into:
//   1. A full edge-health strip (one chip per edge, flex-wrap).
//   2. A destructive banner when ≥1 OpenEMS edge is offline or OpenEMS is
//      unreachable.
//   3. An info banner for the empty state (zero edges).
//
// All data fetching is server-side. No useEffect / client-side OpenEMS calls.
// The quick-action billing link is preserved from the original placeholder.

type EdgeRow = Pick<Edge, "id" | "name" | "data_source_type" | "openems_edge_id">;

async function fetchEdgeStatusMap(
  openemsEdgeIds: string[],
): Promise<{ map: EdgeStatusMap; unreachable: boolean; error: string | null }> {
  if (openemsEdgeIds.length === 0) {
    return { map: {}, unreachable: false, error: null };
  }
  try {
    const client = getOpenEmsClient();
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

export default async function MicrogridDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: edges }, { data: periods }, levels] = await Promise.all([
    supabase
      .from("edges")
      .select("id, name, data_source_type, openems_edge_id")
      .eq("microgrid_id", id)
      .returns<EdgeRow[]>(),
    supabase
      .from("billing_periods")
      .select("*")
      .eq("microgrid_id", id)
      .eq("status", "draft")
      .order("start_date", { ascending: false })
      .limit(1)
      .returns<BillingPeriod[]>(),
    getHierarchyLevels(supabase, { kind: "microgrid", microgridId: id }),
  ]);

  const allEdges: EdgeHealthEntry[] = (edges ?? []).map((e) => ({
    id: e.id,
    name: e.name,
    data_source_type: e.data_source_type,
    openems_edge_id: e.openems_edge_id ?? null,
  }));

  const openemsEdgeIds = allEdges
    .filter((e) => e.data_source_type === "openems" && e.openems_edge_id)
    .map((e) => e.openems_edge_id as string);

  const { map: edgeStatusMap, unreachable, error: statusError } =
    await fetchEdgeStatusMap(openemsEdgeIds);

  const draft = periods?.[0];
  const billingHref = draft
    ? `/microgrids/${id}/billing/${draft.id}`
    : `/microgrids/${id}/billing`;

  // Determine offline OpenEMS edges for the banner.
  // Non-OpenEMS edges with "unknown" chips do NOT contribute.
  const offlineEdges = allEdges.filter((edge) => {
    if (edge.data_source_type !== "openems") return false;
    const status = resolveEdgeStatus(edge, edgeStatusMap);
    return status === "offline" || (unreachable && status === "unknown");
  });

  // Only OpenEMS edges trigger the alert (unreachable counts as needing banner too)
  const showUnreachableBanner = unreachable && openemsEdgeIds.length > 0;
  const showOfflineBanner =
    !unreachable && offlineEdges.length > 0;

  return (
    <div className="space-y-4">
      <HierarchyNav levels={levels} className="mb-2" />

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

      {/* ── Dashboard placeholder + quick-action ─────────────────────────── */}
      <section className="rounded-lg border border-border bg-card p-6">
        <h2 className="text-lg font-semibold text-foreground">Dashboard</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Dashboard insights (consumption calendar, top consumers, anomalies)
          arrive in the next iteration. Jump to Billing to work the current
          period.
        </p>
        <div className="mt-4">
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
