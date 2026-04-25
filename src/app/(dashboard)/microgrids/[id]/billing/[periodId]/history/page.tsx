// Per-period audit history page (BC4, #176).
//
// Server component. Reads the merged audit log via the shared
// `fetchAuditLogEntries` helper (extracted from the BC1 route handler so
// both surfaces share one implementation). Resolves household lookups
// once on the server and hands precomputed maps to <AuditLogList>, which
// owns the (client-side) filter pass + render.
//
// Route shape:
//   /microgrids/[id]/billing/[periodId]/history
//   /microgrids/[id]/billing/[periodId]/history?household_id=<uuid>
//
// The `household_id` query param is passed through from the BC2
// `<RowActionsMenu>` deep link. Filter is applied client-side because
// per-period data is already bounded at ~1000 rows by BC1's per-side
// LIMIT 500.
//
// `searchParams` and `params` are both Promises in Next.js 15 server
// components — `await` before reading.

import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { fetchAuditLogEntries } from "@/lib/billing/audit-log-fetch";
import { AuditLogList } from "@/components/billing/audit-log-list";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import type { BillingPeriod, Household } from "@/lib/types/domain";

export default async function BillingPeriodHistoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; periodId: string }>;
  searchParams: Promise<{ household_id?: string }>;
}) {
  const { id, periodId } = await params;
  const { household_id } = await searchParams;
  const supabase = await createClient();

  // Run independent queries in parallel.
  const [
    { data: period, error: periodError },
    { data: households },
    levels,
    auditResult,
  ] = await Promise.all([
    supabase
      .from("billing_periods")
      .select("id, microgrid_id, start_date, end_date, status, created_at, closed_at")
      .eq("id", periodId)
      .eq("microgrid_id", id)
      .single()
      .then((res) => ({ ...res, data: res.data as BillingPeriod | null })),
    supabase
      .from("households")
      .select("id, display_name")
      .eq("microgrid_id", id)
      .returns<Pick<Household, "id" | "display_name">[]>(),
    getHierarchyLevels(supabase, { kind: "microgrid", microgridId: id }),
    fetchAuditLogEntries(supabase, periodId),
  ]);

  if (periodError || !period) {
    notFound();
  }

  // We don't fail the page on a household-list error — the filter banner
  // just falls back to "unknown household". Surface it as a soft warning
  // via dev console only.
  const householdsList = households ?? [];

  // Resolve the audit-log result discriminator. Anything but `ok` becomes
  // either a notFound() or an inline error banner — never a hard throw.
  if (auditResult.kind === "unauthorized") {
    // Layout middleware should already have redirected, but guard just in
    // case (matches the route handler's contract).
    notFound();
  }
  if (auditResult.kind === "not_found") {
    notFound();
  }
  if (auditResult.kind === "error") {
    return (
      <>
        <HierarchyNav levels={levels} className="mb-4" />
        <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
          Error loading audit history: {auditResult.message}
        </div>
      </>
    );
  }

  const entries = auditResult.entries;

  // ── Build lineItemId → householdId map ─────────────────────────────────
  // The map only needs to cover the line items referenced by entries —
  // we query `billing_line_items` once with an `in` filter scoped to the
  // entry set. This is RLS-scoped (caller only sees line items in
  // microgrids they can access).
  const lineItemIds = Array.from(
    new Set(
      entries
        .map((e) => e.billingLineItemId)
        .filter((v): v is string => Boolean(v))
    )
  );

  const lineItemIdToHouseholdId: Record<string, string> = {};
  if (lineItemIds.length > 0) {
    const { data: lis } = await supabase
      .from("billing_line_items")
      .select("id, household_id")
      .in("id", lineItemIds);
    for (const r of (lis ?? []) as { id: string; household_id: string }[]) {
      lineItemIdToHouseholdId[r.id] = r.household_id;
    }
  }

  const householdNamesById: Record<string, string> = {};
  for (const h of householdsList) {
    householdNamesById[h.id] = h.display_name;
  }

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />

      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-xl font-semibold text-foreground">
          Audit history
        </h1>
        <Link
          href={`/microgrids/${id}/billing/${periodId}`}
          className="text-sm text-muted-foreground underline underline-offset-2 hover:opacity-80"
        >
          Back to period
        </Link>
      </div>

      <AuditLogList
        entries={entries}
        lineItemIdToHouseholdId={lineItemIdToHouseholdId}
        householdNamesById={householdNamesById}
        filterHouseholdId={household_id}
        microgridId={id}
        periodId={periodId}
      />
    </>
  );
}
