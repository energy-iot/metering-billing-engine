import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { BillingPeriod, Edge } from "@/lib/types/domain";
import { Chip } from "@/components/ui/chip";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";

// Microgrid Dashboard landing (D2 / #53).
//
// This ticket ships a MINIMAL placeholder dashboard. The rich widgets
// (consumption calendar, top-consumers leaderboard, anomaly insights,
// activity log) are deferred to a future "Dashboard Widgets" ticket.
//
// What ships here:
//   • Edge-health chip ("N/M edges online") — preserves IA principle #4
//     (edge health above the fold) even without the full visual treatment.
//     Calls OpenEMS directly on the server for the OpenEMS-typed edges
//     attached to this microgrid. We avoid `fetch("/api/openems/status")`
//     from a server component because Next's fetch of its own route on
//     the same request cycle is fragile; the OpenEMS client is already
//     server-side safe.
//   • Quick-action link to the most recent open (draft) billing period,
//     or to the Billing tab if no draft exists.
//   • "Coming soon" placeholder copy setting expectations.

type EdgeRow = Pick<Edge, "id" | "name" | "data_source_type" | "openems_edge_id">;

async function getEdgeHealth(openemsEdgeIds: string[]): Promise<{
  online: number;
  total: number;
  checked: boolean;
  error?: string;
}> {
  const total = openemsEdgeIds.length;
  if (total === 0) {
    return { online: 0, total: 0, checked: true };
  }
  try {
    const client = getOpenEmsClient();
    const statuses = await client.getEdgesStatus(openemsEdgeIds);
    const online = statuses.filter((s) => s.online).length;
    return { online, total, checked: true };
  } catch (err) {
    const message =
      err instanceof OpenEmsError
        ? err.message
        : "Edge health unavailable";
    return { online: 0, total, checked: false, error: message };
  }
}

export default async function MicrogridDashboardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: edges }, { data: periods }] = await Promise.all([
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
  ]);

  const openemsEdgeIds = (edges ?? [])
    .filter((e) => e.data_source_type === "openems" && e.openems_edge_id)
    .map((e) => e.openems_edge_id as string);

  const health = await getEdgeHealth(openemsEdgeIds);

  const draft = periods?.[0];
  const billingHref = draft
    ? `/microgrids/${id}/billing/${draft.id}`
    : `/microgrids/${id}/billing`;

  const healthTone: "success" | "warn" | "alert" | "neutral" = !health.checked
    ? "neutral"
    : health.total === 0
      ? "neutral"
      : health.online === health.total
        ? "success"
        : health.online === 0
          ? "alert"
          : "warn";

  const healthLabel =
    health.total === 0
      ? "No OpenEMS edges"
      : !health.checked
        ? `${health.total} edge${health.total === 1 ? "" : "s"} (status unavailable)`
        : `${health.online}/${health.total} edge${health.total === 1 ? "" : "s"} online`;

  return (
    <div className="space-y-4">
      <section
        aria-label="Edge health"
        className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Edges
        </span>
        <Chip tone={healthTone} dot aria-label={`Edge health: ${healthLabel}`}>
          {healthLabel}
        </Chip>
        {health.error && (
          <span className="text-xs text-muted-foreground">
            {health.error}
          </span>
        )}
      </section>

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
