"use client";

import React, { useState } from "react";
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
import type {
  BillingLineItem,
  BillingPeriod,
  Tenant,
  TierConfig,
} from "@/lib/types/database";

export function BillingTable({
  microgridId,
  period,
  lineItems,
  tenants,
  tiers,
  currency,
}: {
  microgridId: string;
  period: BillingPeriod;
  lineItems: BillingLineItem[];
  tenants: Tenant[];
  tiers: TierConfig[];
  currency: string;
}) {
  const router = useRouter();
  const supabase = createClient();
  const { locale, currency: localeCurrency } = useLocale();

  const [generating, setGenerating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generateErrors, setGenerateErrors] = useState<
    { tenantName: string; error: string }[]
  >([]);

  // Dialog state
  const [closePeriodOpen, setClosePeriodOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const isDraft = period.status === "draft";

  // Build tenantId -> lineItem map
  const lineItemMap = new Map<string, BillingLineItem>();
  for (const item of lineItems) {
    lineItemMap.set(item.tenant_id, item);
  }

  // Grand totals
  let grandTotalKwh = 0;
  let grandTotal = 0;
  const grandTierKwh: number[] = tiers.map(() => 0);
  const grandTierAmount: number[] = tiers.map(() => 0);

  for (const item of lineItems) {
    grandTotalKwh += item.usage_kwh;
    grandTotal += item.total_amount;

    for (let i = 0; i < item.tier_breakdown.length && i < tiers.length; i++) {
      grandTierKwh[i] += item.tier_breakdown[i].kwh;
      grandTierAmount[i] += item.tier_breakdown[i].amount;
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
          data.errors.map((e: { tenantName: string; error: string }) => ({
            tenantName: e.tenantName,
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
      label: "Tenants",
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

  const columns: ColumnDef<Tenant>[] = [
    {
      kind: "row-header",
      header: "Tenant",
      accessor: (t) => t.name,
    },
    {
      kind: "value",
      header: "Begin (kWh)",
      accessor: (t) => lineItemMap.get(t.id)?.start_kwh ?? null,
      format: (v) => (v == null ? "—" : kwhFormat(v)),
    },
    {
      kind: "value",
      header: "End (kWh)",
      accessor: (t) => lineItemMap.get(t.id)?.end_kwh ?? null,
      format: (v) => (v == null ? "—" : kwhFormat(v)),
    },
    {
      kind: "value",
      header: "Usage (kWh)",
      accessor: (t) => lineItemMap.get(t.id)?.usage_kwh ?? null,
      format: (v) => (v == null ? "—" : kwhFormat(v)),
    },
    ...tiers.flatMap((tier, i): ColumnDef<Tenant>[] => [
      {
        kind: "value",
        header: `${tier.label} kWh`,
        accessor: (t) => lineItemMap.get(t.id)?.tier_breakdown[i]?.kwh ?? null,
        format: (v) => (v == null ? "—" : kwhFormat(v)),
      },
      {
        kind: "value",
        header: `${tier.label} (${currency})`,
        accessor: (t) => lineItemMap.get(t.id)?.tier_breakdown[i]?.amount ?? null,
        format: (v) => (v == null ? "—" : amountFormat(v)),
      },
    ]),
    {
      kind: "value",
      header: `Total (${currency})`,
      accessor: (t) => lineItemMap.get(t.id)?.total_amount ?? null,
      format: (v) => (v == null ? "—" : amountFormat(v)),
    },
  ];

  // Tenants with line items for the CopyTable (only tenants that have data)
  const tenantsWithItems = tenants.filter((t) => lineItemMap.has(t.id));

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
            Some tenants could not be billed:
          </p>
          <ul className="mt-1 list-inside list-disc">
            {generateErrors.map((e, i) => (
              <li key={i}>
                {e.tenantName}: {e.error}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Billing Table */}
      <div className="rounded-lg border border-border bg-card p-6">
        {lineItems.length === 0 && tenants.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            No billing data yet.{" "}
            {isDraft
              ? 'Click "Generate" to fetch meter readings and calculate costs.'
              : ""}
          </p>
        ) : tenants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No tenants configured for this microgrid.
          </p>
        ) : tenantsWithItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No billing data yet.{" "}
            {isDraft
              ? 'Click "Generate" to fetch meter readings and calculate costs.'
              : ""}
          </p>
        ) : (
          <div className="space-y-4">
            <CopyTable
              rows={tenantsWithItems}
              columns={columns}
              caption={`Billing table for period ${periodLabel} — ${tenantsWithItems.length} tenant${tenantsWithItems.length !== 1 ? "s" : ""}`}
              ariaLabel={`Billing data for ${periodLabel}`}
            />

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
