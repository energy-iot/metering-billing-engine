import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { StatusChip } from "@/components/ui/status-chip";
import { Currency } from "@/components/format/currency";
import { Kwh } from "@/components/format/kwh";
import { EmptyState } from "@/components/ui/empty-state";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";

// Setup > Households > [householdId] — Household detail page (D3 / #54).
//
// Renders: household basics, portal users count, linked devices table,
// billing history (last 3 closed periods).
//
// Single stacked layout — no sub-tabs (confirmed design decision).
// HierarchyNav is out-of-scope (D4 / #55 owns placement).
// Editing household fields is deferred to a future ticket.

// ── Types ─────────────────────────────────────────────────────────────────────

type DeviceRow = {
  id: string;
  name: string;
  device_type: string;
  edges: { id: string; name: string } | null;
};

type HouseholdDeviceRow = {
  role: string;
  devices: DeviceRow | null;
};

type HouseholdRow = {
  id: string;
  display_name: string | null;
  primary_phone: string | null;
  primary_email: string | null;
  address_line1: string | null;
  address_line2: string | null;
  unit_label: string | null;
  household_devices: HouseholdDeviceRow[];
};

type BillingLineItemRow = {
  usage_kwh: number | null;
  total_amount: number | null;
  billing_periods: {
    id: string;
    start_date: string;
    end_date: string;
    status: string;
  };
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function HouseholdDetailPage({
  params,
}: {
  params: Promise<{ id: string; householdId: string }>;
}) {
  const { id: microgridId, householdId } = await params;
  const supabase = await createClient();

  // Query 1 — household basics + linked devices (single round-trip).
  const { data: household, error: householdError } = await supabase
    .from("households")
    .select(
      `id, display_name, primary_phone, primary_email,
       address_line1, address_line2, unit_label,
       household_devices(role, devices(id, name, device_type, edges(id, name)))`,
    )
    .eq("id", householdId)
    .eq("microgrid_id", microgridId)
    .maybeSingle<HouseholdRow>();

  if (householdError) {
    // #300: previously a query/embed error (RLS on the devices/edges embed, or a
    // relationship-resolution failure) was masked as a 404 by folding it into
    // notFound(). Surface it — log structured + throw — so the real PostgREST
    // error is visible (dev overlay / prod 500 + logs) instead of a misleading
    // "not found." A genuinely-missing household still 404s via the !household
    // branch below (maybeSingle returns null, not an error, for 0 rows).
    console.error(
      JSON.stringify({
        event: "household_detail.query_error",
        householdId,
        microgridId,
        code: householdError.code,
        message: householdError.message,
        details: householdError.details,
        hint: householdError.hint,
        at: new Date().toISOString(),
      }),
    );
    throw new Error(
      `Failed to load household ${householdId}: ${householdError.message}`,
    );
  }

  if (!household) {
    notFound();
  }

  // Query 2 — portal users count.
  const { count: portalUserCount } = await supabase
    .from("household_users")
    .select("*", { count: "exact", head: true })
    .eq("household_id", householdId);

  // Query 3 — last 3 closed billing periods' line items for this household.
  const { data: lineItems } = await supabase
    .from("billing_line_items")
    .select(
      `usage_kwh, total_amount,
       billing_periods!inner(id, start_date, end_date, status)`,
    )
    .eq("household_id", householdId)
    .eq("billing_periods.status", "closed")
    .order("billing_periods(end_date)", { ascending: false })
    .limit(3)
    .returns<BillingLineItemRow[]>();

  const devices = household.household_devices ?? [];
  const closedLineItems = (lineItems ?? []).filter(
    (li) => li.billing_periods?.status === "closed",
  );

  // Resolve role + available unlinked consumption meters for P7 empty state (#139).
  const canManage = await currentUserCanAccessMicrogrid(supabase, microgridId);

  // Count unlinked consumption meters on this microgrid (sequential queries kept
  // simple to avoid dynamic .not("id","in",...) edge cases with empty arrays).
  const [edgesResult, assignedResult] = await Promise.all([
    supabase.from("edges").select("id").eq("microgrid_id", microgridId),
    supabase
      .from("household_devices")
      .select("device_id")
      .eq("role", "primary_consumption_meter"),
  ]);
  const microgridEdgeIds = (edgesResult.data ?? []).map((e) => e.id);
  const assignedDeviceIds = (assignedResult.data ?? []).map((r) => r.device_id);

  let hasMetersAvailable = false;
  if (microgridEdgeIds.length > 0) {
    let metersQuery = supabase
      .from("devices")
      .select("id", { count: "exact", head: true })
      .in("edge_id", microgridEdgeIds)
      .eq("device_type", "consumption_meter");

    if (assignedDeviceIds.length > 0) {
      metersQuery = metersQuery.not("id", "in", `(${assignedDeviceIds.join(",")})`);
    }

    const { count } = await metersQuery;
    hasMetersAvailable = (count ?? 0) > 0;
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <div>
        <Link
          href={`/microgrids/${microgridId}/setup/households`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to households
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h3 className="text-lg font-semibold text-foreground">
            {household.display_name ?? "Unnamed household"}
          </h3>
        </div>
      </div>

      {/* ── Section 1: Household basics ─────────────────────────────────────── */}
      <section aria-labelledby="basics-heading">
        <h4
          id="basics-heading"
          className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Household basics
        </h4>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <dl className="divide-y divide-border">
            <BasicRow label="Display name" value={household.display_name} />
            <BasicRow label="Phone" value={household.primary_phone} />
            <BasicRow label="Email" value={household.primary_email} />
            <BasicRow label="Address line 1" value={household.address_line1} />
            <BasicRow label="Address line 2" value={household.address_line2} />
            <BasicRow label="Unit label" value={household.unit_label} />
          </dl>
        </div>
      </section>

      {/* ── Section 2: Portal users ─────────────────────────────────────────── */}
      <section aria-labelledby="portal-users-heading">
        <h4
          id="portal-users-heading"
          className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Portal users
        </h4>
        <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-foreground">
          {portalUserCount ?? 0} portal user{(portalUserCount ?? 0) === 1 ? "" : "s"} linked
        </div>
      </section>

      {/* ── Section 3: Linked devices ───────────────────────────────────────── */}
      <section aria-labelledby="devices-heading">
        <h4
          id="devices-heading"
          className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Linked devices
        </h4>
        {devices.length === 0 ? (
          <EmptyState
            tone="warn"
            eyebrow="Linked devices"
            title="Link this household to its meter"
            body={
              <>
                Pick a device from this microgrid&apos;s edges and mark it the
                primary consumption meter. Only households with a primary meter
                get billed.
              </>
            }
            secondary={
              canManage ? (
                <Link
                  href={`/microgrids/${microgridId}/setup/households`}
                  className="text-sm font-medium text-foreground underline hover:opacity-80"
                >
                  Go to Households listing →
                </Link>
              ) : undefined
            }
            footnote={
              !canManage
                ? `Ask a super admin to link a meter to ${household.display_name ?? "this household"}.`
                : hasMetersAvailable
                  ? "Go to Setup › Households and pick this household's primary meter from the row dropdown. A dedicated Link Device dialog is coming soon."
                  : "No unlinked consumption meters on this microgrid yet — run device discovery on an edge first."
            }
          />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Device
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Type
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Role
                  </th>
                  <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Edge
                  </th>
                </tr>
              </thead>
              <tbody>
                {devices.map((hd, idx) => {
                  const device = hd.devices;
                  const isPrimary = hd.role === "primary_consumption_meter";
                  return (
                    <tr
                      key={device?.id ?? idx}
                      className={`border-t border-border${isPrimary ? " bg-warning-muted/30" : ""}`}
                    >
                      <td className="px-4 py-3 font-medium text-foreground">
                        {device?.name ?? "—"}
                      </td>
                      <td className="px-4 py-3">
                        {device?.device_type ? (
                          <StatusChip
                            kind="deviceType"
                            status={device.device_type}
                          />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <StatusChip
                          kind="householdDeviceRole"
                          status={hd.role}
                        />
                      </td>
                      <td className="px-4 py-3 text-sm">
                        {device?.edges ? (
                          <Link
                            href={`/microgrids/${microgridId}/setup/edges/${device.edges.id}/`}
                            className="text-foreground underline underline-offset-2 hover:text-muted-foreground"
                          >
                            {device.edges.name}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── Section 4: Billing history ──────────────────────────────────────── */}
      <section aria-labelledby="billing-heading">
        <h4
          id="billing-heading"
          className="mb-3 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Billing history (last 3 closed periods)
        </h4>
        {closedLineItems.length === 0 ? (
          <p className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
            No billing history
          </p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            <table className="w-full text-left text-sm">
              <thead className="bg-muted">
                <tr>
                  <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Period
                  </th>
                  <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Usage (kWh)
                  </th>
                  <th className="px-4 py-2 text-right text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {closedLineItems.map((li, idx) => {
                  const bp = li.billing_periods;
                  return (
                    <tr key={bp?.id ?? idx} className="border-t border-border">
                      <td className="px-4 py-3 text-foreground">
                        {bp ? (
                          <span>
                            {bp.start_date} — {bp.end_date}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {li.usage_kwh != null ? (
                          <Kwh value={li.usage_kwh} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {li.total_amount != null ? (
                          <Currency value={li.total_amount} />
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function BasicRow({
  label,
  value,
}: {
  label: string;
  value: string | null | undefined;
}) {
  return (
    <div className="flex items-baseline gap-4 px-4 py-3">
      <dt className="w-36 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm text-foreground">{value ?? "—"}</dd>
    </div>
  );
}
