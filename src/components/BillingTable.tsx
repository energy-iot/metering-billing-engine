"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CopyButton } from "@/components/CopyButton";
import { Currency } from "@/components/format/currency";
import { formatCurrency } from "@/components/format/currency";
import { Kwh } from "@/components/format/kwh";
import { formatKwh } from "@/components/format/kwh";
import { LocalDate } from "@/components/format/local-date";
import { useLocale } from "@/components/format/locale-context";
import { StatusChip } from "@/components/ui/status-chip";
import { CopyTable, type ColumnDef } from "@/components/ui/copy-table";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ClosePeriodDialog, type ClosePeriodSummaryRow } from "@/components/ui/close-period-dialog";
import { Banner } from "@/components/ui/banner";
import { PaymentRowActions } from "@/components/billing/payment-row-actions";
import { ManualUsageCell } from "@/components/billing/manual-usage-cell";
import type {
  BillingLineItem,
  BillingPeriod,
  Household,
  TierConfig,
} from "@/lib/types/domain";

const GATE_BANNER_ID = "payment-gate-banner";

export function BillingTable({
  microgridId,
  period,
  lineItems,
  households,
  tiers,
  currency,
  isPaymentConfigured = true,
  isSuperAdmin = false,
  communityId,
}: {
  microgridId: string;
  period: BillingPeriod;
  lineItems: BillingLineItem[];
  households: Household[];
  tiers: TierConfig[];
  currency: string;
  /** Whether the community has a payment provider configured. Default: true (no gate banner). */
  isPaymentConfigured?: boolean;
  /** Whether the current user is a super_admin. Controls gate banner copy. Default: false. */
  isSuperAdmin?: boolean;
  /** Community id — used for the super_admin "Go to Payment tab" link. */
  communityId?: string;
}) {
  const router = useRouter();
  const supabase = createClient();
  const { locale, currency: localeCurrency } = useLocale();

  const [generating, setGenerating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generateErrors, setGenerateErrors] = useState<
    { householdName: string; error: string }[]
  >([]);

  // Dialog state
  const [closePeriodOpen, setClosePeriodOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const isDraft = period.status === "draft";

  // Build householdId -> lineItem map
  const lineItemMap = new Map<string, BillingLineItem>();
  for (const item of lineItems) {
    lineItemMap.set(item.household_id, item);
  }

  // #158: per-row error message surfaced from the inline-edit cells. Keyed
  // by line item id so a failure on one un-metered row doesn't clobber the
  // others. Cleared on next successful save or Esc-revert.
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const recordRowError = React.useCallback(
    (lineItemId: string, message: string | null) => {
      setRowErrors((prev) => {
        if (message === null) {
          if (!(lineItemId in prev)) return prev;
          const next = { ...prev };
          delete next[lineItemId];
          return next;
        }
        return { ...prev, [lineItemId]: message };
      });
    },
    []
  );

  // Grand totals
  let grandTotalKwh = 0;
  let grandTotal = 0;
  const grandTierKwh: number[] = tiers.map(() => 0);
  const grandTierAmount: number[] = tiers.map(() => 0);

  for (const item of lineItems) {
    // #158: usage_kwh may be NULL on un-metered rows that haven't been
    // filled in yet. Treat NULL as 0 in the grand total — the row reads as
    // an em-dash in the per-cell display, but it shouldn't poison the sum.
    grandTotalKwh += item.usage_kwh ?? 0;
    grandTotal += item.total_amount;

    const breakdown = item.tier_breakdown as { label: string; kwh: number; amount: number }[];
    for (let i = 0; i < breakdown.length && i < tiers.length; i++) {
      grandTierKwh[i] += breakdown[i].kwh;
      grandTierAmount[i] += breakdown[i].amount;
    }
  }

  async function handleGenerate() {
    setError(null);
    setGenerateErrors([]);
    setGenerating(true);

    try {
      const res = await fetch("/api/billing/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ billingPeriodId: period.id }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to generate billing data");
        setGenerating(false);
        return;
      }

      if (data.errors && data.errors.length > 0) {
        setGenerateErrors(
          data.errors.map((e: { householdName: string; error: string }) => ({
            householdName: e.householdName,
            error: e.error,
          }))
        );
      }

      setGenerating(false);
      router.refresh();
    } catch {
      setError("Network error while generating billing data");
      setGenerating(false);
    }
  }

  async function handleDelete() {
    setError(null);
    setDeleting(true);
    const { error: deleteError } = await supabase
      .from("billing_periods")
      .delete()
      .eq("id", period.id);
    if (deleteError) {
      setDeleting(false);
      throw new Error(deleteError.message);
    }
    router.push(`/microgrids/${microgridId}/billing`);
  }

  async function handleClose() {
    setError(null);
    setClosing(true);

    const { error: updateError } = await supabase
      .from("billing_periods")
      .update({
        status: "closed",
        closed_at: new Date().toISOString(),
      })
      .eq("id", period.id);

    if (updateError) {
      setClosing(false);
      throw new Error(updateError.message);
    }

    setClosing(false);
    router.refresh();
  }

  // Build period label for ClosePeriodDialog
  const periodLabel =
    period.start_date === period.end_date
      ? period.start_date
      : `${period.start_date} – ${period.end_date}`;

  // Build summary rows for ClosePeriodDialog
  const closePeriodSummaryRows: ClosePeriodSummaryRow[] = [
    {
      label: "Households",
      value: String(lineItems.length),
    },
    {
      label: `Total (${currency})`,
      value: <Currency value={grandTotal} bareNumber />,
    },
    {
      label: "Total (kWh)",
      value: <Kwh value={grandTotalKwh} bareNumber />,
    },
  ];

  // CopyTable columns built from tiers
  // Format helpers (plain string, for CopyTable column defs)
  const kwhFormat = (v: number | string | null) =>
    formatKwh(v == null ? null : Number(v), locale, { bareNumber: true });
  const amountFormat = (v: number | string | null) =>
    formatCurrency(v == null ? null : Number(v), locale, localeCurrency, { bareNumber: true });

  const columns: ColumnDef<Household>[] = [
    {
      kind: "row-header",
      header: "Household",
      accessor: (h) => h.display_name,
    },
    {
      kind: "value",
      header: "Begin (kWh)",
      accessor: (h) => lineItemMap.get(h.id)?.start_kwh ?? null,
      format: (v) => (v == null ? "—" : kwhFormat(v)),
    },
    // #158: END (kWh) and USAGE (kWh) are inline-editable for un-metered
    // rows (lineItem.device_id == null). Metered rows render the same
    // visual as before via ManualUsageCell's read-only path. We render
    // these as `action` columns so the inline <input> doesn't fight the
    // CopyTable's keyboard nav grid; un-metered rows are operator-entry
    // surfaces, not URA-paste targets.
    {
      kind: "action",
      header: "End (kWh)",
      className: "text-right",
      render: (h) => {
        const item = lineItemMap.get(h.id);
        if (!item) return <span className="text-muted-foreground">—</span>;
        const isUnmetered = item.device_id == null;
        return (
          <ManualUsageCell
            lineItemId={item.id}
            field="end_kwh"
            value={item.end_kwh}
            format={(v) => (v == null ? "—" : kwhFormat(v))}
            editable={isUnmetered && isDraft}
            onError={recordRowError}
          />
        );
      },
    },
    {
      kind: "action",
      header: "Usage (kWh)",
      className: "text-right",
      render: (h) => {
        const item = lineItemMap.get(h.id);
        if (!item) return <span className="text-muted-foreground">—</span>;
        const isUnmetered = item.device_id == null;
        return (
          <ManualUsageCell
            lineItemId={item.id}
            field="usage_kwh"
            value={item.usage_kwh}
            format={(v) => (v == null ? "—" : kwhFormat(v))}
            editable={isUnmetered && isDraft}
            onError={recordRowError}
          />
        );
      },
    },
    ...tiers.flatMap((tier, i): ColumnDef<Household>[] => [
      {
        kind: "value",
        header: `${tier.label} kWh`,
        accessor: (h) => {
          const bd = lineItemMap.get(h.id)?.tier_breakdown as { label: string; kwh: number; amount: number }[] | undefined;
          return bd?.[i]?.kwh ?? null;
        },
        format: (v) => (v == null ? "—" : kwhFormat(v)),
      },
      {
        kind: "value",
        header: `${tier.label} (${currency})`,
        accessor: (h) => {
          const bd = lineItemMap.get(h.id)?.tier_breakdown as { label: string; kwh: number; amount: number }[] | undefined;
          return bd?.[i]?.amount ?? null;
        },
        format: (v) => (v == null ? "—" : amountFormat(v)),
      },
    ]),
    {
      kind: "value",
      header: `Total (${currency})`,
      accessor: (h) => lineItemMap.get(h.id)?.total_amount ?? null,
      format: (v) => (v == null ? "—" : amountFormat(v)),
    },
    {
      kind: "action",
      header: "Payment",
      render: (h) => {
        const item = lineItemMap.get(h.id);
        if (!item) return null;

        // Build period label for the ConfirmDialog body.
        const periodLabel =
          period.start_date === period.end_date
            ? period.start_date
            : `${period.start_date} – ${period.end_date}`;

        return (
          <PaymentRowActions
            lineItemId={item.id}
            isPaymentConfigured={isPaymentConfigured}
            lineItem={{
              id: item.id,
              payment_status: item.payment_status,
              household_name: h.display_name,
              period_label: periodLabel,
              total_amount: item.total_amount,
              currency: localeCurrency,
            }}
          />
        );
      },
    },
  ];

  // Households with line items for the CopyTable (only households that have data)
  const householdsWithItems = households.filter((h) => lineItemMap.has(h.id));

  return (
    <div className="space-y-4">
      {/* Delete Period Dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete period?"
        description="This permanently removes the period and all its line items."
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={handleDelete}
      />

      {/* Close Period Dialog */}
      <ClosePeriodDialog
        open={closePeriodOpen}
        onOpenChange={setClosePeriodOpen}
        periodLabel={periodLabel}
        summaryRows={closePeriodSummaryRows}
        grandTotal={grandTotal}
        onConfirm={handleClose}
      />

      {/* Header */}
      <div className="rounded-lg border border-border bg-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">
              {period.start_date === period.end_date ? (
                <LocalDate value={period.start_date + "T00:00:00"} />
              ) : (
                <>
                  <LocalDate value={period.start_date + "T00:00:00"} />
                  {" – "}
                  <LocalDate value={period.end_date + "T00:00:00"} />
                </>
              )}
            </h2>
            <span className="mt-1 inline-block">
              <StatusChip kind="billingPeriod" status={period.status} />
            </span>
          </div>

          <div className="flex gap-2">
            {isDraft && (
              <>
                <button
                  onClick={handleGenerate}
                  disabled={generating || closing || deleting}
                  className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generating
                    ? "Generating..."
                    : lineItems.length > 0
                      ? "Refresh Readings"
                      : "Generate"}
                </button>
                <button
                  onClick={() => setClosePeriodOpen(true)}
                  disabled={generating || closing || deleting || lineItems.length === 0}
                  className="rounded-md border border-border bg-card px-4 py-2 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {closing ? "Closing..." : "Close Period"}
                </button>
              </>
            )}
            <button
              onClick={() => setDeleteDialogOpen(true)}
              disabled={generating || closing || deleting}
              className="rounded-md border border-destructive bg-card px-4 py-2 text-sm text-destructive hover:bg-destructive-muted disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </div>

      {/* Errors */}
      {error && (
        <div className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {error}
        </div>
      )}

      {/* Generate warnings */}
      {generateErrors.length > 0 && (
        <div className="rounded-md bg-warning-muted p-3 text-sm text-warning-fg">
          <p className="font-medium">
            Some households could not be billed:
          </p>
          <ul className="mt-1 list-inside list-disc">
            {generateErrors.map((e, i) => (
              <li key={i}>
                {e.householdName}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Billing Table */}
      <div className="rounded-lg border border-border bg-card p-6">
        {lineItems.length === 0 && households.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            No billing data yet.{" "}
            {isDraft
              ? 'Click "Generate" to fetch meter readings and calculate costs.'
              : ""}
          </p>
        ) : households.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No households configured for this microgrid.
          </p>
        ) : householdsWithItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No billing data yet.{" "}
            {isDraft
              ? 'Click "Generate" to fetch meter readings and calculate costs.'
              : ""}
          </p>
        ) : (
          <div className="space-y-4">
            {/* Gate banner: shown when community has no payment provider configured */}
            {!isPaymentConfigured && (
              <Banner
                id={GATE_BANNER_ID}
                tone="warn"
                title="No payment provider configured"
              >
                {isSuperAdmin ? (
                  <>
                    Connect a payment provider to generate payment links.{" "}
                    {communityId && (
                      <Link
                        href={`/communities/${communityId}/payment`}
                        className="text-sm font-medium text-warning-fg underline"
                      >
                        Go to Payment tab
                      </Link>
                    )}
                  </>
                ) : (
                  "Ask a super admin to configure Payment for this community."
                )}
              </Banner>
            )}

            <CopyTable
              rows={householdsWithItems}
              columns={columns}
              caption={`Billing table for period ${periodLabel} — ${householdsWithItems.length} household${householdsWithItems.length !== 1 ? "s" : ""}`}
              ariaLabel={`Billing data for ${periodLabel}`}
            />

            {/* #158: surface per-row inline-edit errors below the grid so
                they aren't trapped inside the CopyTable's static markup.
                Cleared automatically when the user successfully retries or
                presses Esc on the cell. */}
            {Object.keys(rowErrors).length > 0 && (
              <ul className="space-y-1 rounded-md border border-destructive bg-destructive-muted p-3 text-xs text-destructive-fg">
                {Object.entries(rowErrors).map(([lineItemId, message]) => {
                  const item = lineItems.find((li) => li.id === lineItemId);
                  const householdName = households.find(
                    (h) => h.id === item?.household_id
                  )?.display_name;
                  return (
                    <li key={lineItemId} className="flex items-center justify-between gap-2">
                      <span>
                        {householdName ? `${householdName}: ` : ""}
                        Could not save: {message}
                      </span>
                      <button
                        type="button"
                        onClick={() => recordRowError(lineItemId, null)}
                        className="rounded-sm border border-destructive bg-card px-2 py-0.5 text-[11px] font-medium text-destructive-fg hover:bg-muted"
                      >
                        Dismiss
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}

            {/* Grand-total footer — rendered BELOW the CopyTable */}
            {lineItems.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t-2 border-border pt-3 text-sm font-medium text-foreground">
                <span className="w-32 text-foreground">Total</span>
                <span className="whitespace-nowrap">
                  <span className="text-xs text-muted-foreground mr-1">kWh</span>
                  <Kwh value={grandTotalKwh} bareNumber />
                  <CopyButton value={grandTotalKwh} />
                </span>
                {tiers.map((_, i) => (
                  <React.Fragment key={`grand-tier-${i}`}>
                    <span className="whitespace-nowrap">
                      <span className="text-xs text-muted-foreground mr-1">{tiers[i].label} kWh</span>
                      <Kwh value={grandTierKwh[i]} bareNumber />
                      <CopyButton value={grandTierKwh[i]} />
                    </span>
                    <span className="whitespace-nowrap">
                      <span className="text-xs text-muted-foreground mr-1">{tiers[i].label} ({currency})</span>
                      <Currency value={grandTierAmount[i]} bareNumber />
                      <CopyButton value={grandTierAmount[i]} />
                    </span>
                  </React.Fragment>
                ))}
                <span className="whitespace-nowrap">
                  <span className="text-xs text-muted-foreground mr-1">Total ({currency})</span>
                  <Currency value={grandTotal} bareNumber />
                  <CopyButton value={grandTotal} />
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
