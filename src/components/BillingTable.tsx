"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { CopyButton } from "@/components/CopyButton";
import type {
  BillingLineItem,
  BillingPeriod,
  Tenant,
  TierConfig,
} from "@/lib/types/database";

function formatAmount(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
}

function formatKwh(value: number): string {
  return new Intl.NumberFormat("en", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatDate(dateStr: string): string {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

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

  const [generating, setGenerating] = useState(false);
  const [closing, setClosing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generateErrors, setGenerateErrors] = useState<
    { tenantName: string; error: string }[]
  >([]);

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
    const dateRange = `${formatDate(period.start_date)} – ${formatDate(period.end_date)}`;
    const message =
      period.status === "closed"
        ? `Permanently delete this closed billing period (${dateRange}) and all its finalized bills? This cannot be undone.`
        : `Delete this draft billing period (${dateRange}) and any generated bills? This cannot be undone.`;
    if (!confirm(message)) return;
    setError(null);
    setDeleting(true);
    const { error: deleteError } = await supabase
      .from("billing_periods")
      .delete()
      .eq("id", period.id);
    if (deleteError) {
      setError(deleteError.message);
      setDeleting(false);
      return;
    }
    router.push(`/microgrids/${microgridId}/billing`);
  }

  async function handleClose() {
    if (
      !confirm(
        "Are you sure you want to close this billing period? This action cannot be undone."
      )
    ) {
      return;
    }

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
      setError(updateError.message);
      setClosing(false);
      return;
    }

    setClosing(false);
    router.refresh();
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">
              {formatDate(period.start_date)} &ndash;{" "}
              {formatDate(period.end_date)}
            </h2>
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                period.status === "closed"
                  ? "bg-green-100 text-green-800"
                  : "bg-yellow-100 text-yellow-800"
              }`}
            >
              {period.status}
            </span>
          </div>

          <div className="flex gap-2">
            {isDraft && (
              <>
                <button
                  onClick={handleGenerate}
                  disabled={generating || closing || deleting}
                  className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {generating
                    ? "Generating..."
                    : lineItems.length > 0
                      ? "Refresh Readings"
                      : "Generate"}
                </button>
                <button
                  onClick={handleClose}
                  disabled={generating || closing || deleting || lineItems.length === 0}
                  className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {closing ? "Closing..." : "Close Period"}
                </button>
              </>
            )}
            <button
              onClick={handleDelete}
              disabled={generating || closing || deleting}
              className="rounded-md border border-red-300 bg-white px-4 py-2 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {deleting ? "Deleting..." : "Delete"}
            </button>
          </div>
        </div>
      </div>

      {/* Errors */}
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Generate warnings */}
      {generateErrors.length > 0 && (
        <div className="rounded-md bg-yellow-50 p-3 text-sm text-yellow-700">
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
      <div className="rounded-lg border border-gray-200 bg-white p-6">
        {lineItems.length === 0 && tenants.length > 0 ? (
          <p className="text-sm text-gray-500">
            No billing data yet.{" "}
            {isDraft
              ? 'Click "Generate" to fetch meter readings and calculate costs.'
              : ""}
          </p>
        ) : tenants.length === 0 ? (
          <p className="text-sm text-gray-500">
            No tenants configured for this microgrid.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="pb-2 pr-4 font-medium text-gray-700">
                    Tenant
                  </th>
                  <th className="pb-2 pr-4 text-right font-medium text-gray-700">
                    Usage (kWh)
                  </th>
                  {tiers.map((tier, i) => (
                    <React.Fragment key={`tier-hdr-${i}`}>
                      <th className="pb-2 pr-2 text-right font-medium text-gray-700">
                        {tier.label} kWh
                      </th>
                      <th className="pb-2 pr-2 text-right font-medium text-gray-700">
                        {tier.label} ({currency})
                      </th>
                    </React.Fragment>
                  ))}
                  <th className="pb-2 text-right font-medium text-gray-700">
                    Total ({currency})
                  </th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((tenant) => {
                  const item = lineItemMap.get(tenant.id);

                  if (!item) {
                    return (
                      <tr
                        key={tenant.id}
                        className="border-b border-gray-100"
                      >
                        <td className="py-3 pr-4 text-gray-900">
                          {tenant.name}
                        </td>
                        <td
                          className="py-3 pr-4 text-right text-gray-400"
                          colSpan={tiers.length * 2 + 2}
                        >
                          {tenant.meter_id ? "No data" : "No meter"}
                        </td>
                      </tr>
                    );
                  }

                  return (
                    <tr
                      key={tenant.id}
                      className="border-b border-gray-100"
                    >
                      <td className="py-3 pr-4 text-gray-900">
                        {tenant.name}
                      </td>
                      <td className="whitespace-nowrap py-3 pr-4 text-right text-gray-900">
                        {formatKwh(item.usage_kwh)}
                        <CopyButton value={item.usage_kwh} />
                      </td>
                      {tiers.map((_, i) => {
                        const tierData = item.tier_breakdown[i];
                        const kwh = tierData?.kwh ?? 0;
                        const amount = tierData?.amount ?? 0;
                        return (
                          <React.Fragment key={`tier-${i}`}>
                            <td className="whitespace-nowrap py-3 pr-2 text-right text-gray-900">
                              {formatKwh(kwh)}
                              <CopyButton value={kwh} />
                            </td>
                            <td className="whitespace-nowrap py-3 pr-2 text-right text-gray-900">
                              {formatAmount(amount)}
                              <CopyButton value={amount} />
                            </td>
                          </React.Fragment>
                        );
                      })}
                      <td className="whitespace-nowrap py-3 text-right font-medium text-gray-900">
                        {formatAmount(item.total_amount)}
                        <CopyButton value={item.total_amount} />
                      </td>
                    </tr>
                  );
                })}

                {/* Grand total row */}
                {lineItems.length > 0 && (
                  <tr className="border-t-2 border-gray-300 font-medium">
                    <td className="py-3 pr-4 text-gray-900">Total</td>
                    <td className="whitespace-nowrap py-3 pr-4 text-right text-gray-900">
                      {formatKwh(grandTotalKwh)}
                      <CopyButton value={grandTotalKwh} />
                    </td>
                    {tiers.map((_, i) => (
                      <React.Fragment key={`grand-tier-${i}`}>
                        <td className="whitespace-nowrap py-3 pr-2 text-right text-gray-900">
                          {formatKwh(grandTierKwh[i])}
                          <CopyButton value={grandTierKwh[i]} />
                        </td>
                        <td className="whitespace-nowrap py-3 pr-2 text-right text-gray-900">
                          {formatAmount(grandTierAmount[i])}
                          <CopyButton value={grandTierAmount[i]} />
                        </td>
                      </React.Fragment>
                    ))}
                    <td className="whitespace-nowrap py-3 text-right text-gray-900">
                      {formatAmount(grandTotal)}
                      <CopyButton value={grandTotal} />
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
