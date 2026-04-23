"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { BillingPeriod } from "@/lib/types/domain";
import { StatusChip } from "@/components/ui/status-chip";
import { Currency } from "@/components/format/currency";
import { Kwh } from "@/components/format/kwh";
import { LocalDate } from "@/components/format/local-date";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PeriodPicker, type PeriodOption } from "@/components/ui/period-picker";

function toPeriodOption(
  period: BillingPeriod,
  summaries: Record<string, { totalKwh: number; totalAmount: number } | undefined>,
): PeriodOption {
  return {
    id: period.id,
    startDate: period.start_date,
    endDate: period.end_date,
    status: period.status,
    totalAmount: summaries[period.id]?.totalAmount ?? 0,
  };
}

function getDefaultDates() {
  const now = new Date();
  const year = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
  const month = now.getMonth() === 0 ? 11 : now.getMonth() - 1; // previous month (0-indexed)
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);

  return {
    start: firstDay.toISOString().split("T")[0],
    end: lastDay.toISOString().split("T")[0],
  };
}

export function BillingPeriodList({
  microgridId,
  periods,
  summaries,
  currency,
}: {
  microgridId: string;
  periods: BillingPeriod[];
  summaries: Record<string, { totalKwh: number; totalAmount: number } | undefined>;
  currency: string;
}) {
  const router = useRouter();
  const supabase = createClient();

  const defaults = getDefaultDates();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [startDate, setStartDate] = useState(defaults.start);
  const [endDate, setEndDate] = useState(defaults.end);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatingUrlPeriodId, setGeneratingUrlPeriodId] = useState<string | null>(null);
  const [urlFeedback, setUrlFeedback] = useState<
    { periodId: string; kind: "success" | "error"; message: string } | null
  >(null);

  async function handleGetBillingUrl(period: BillingPeriod) {
    setUrlFeedback(null);
    setGeneratingUrlPeriodId(period.id);

    // Other components on the page can contribute params by appending to this
    // body. For now we send an empty body and let the server fall back to
    // placeholders.
    const requestBody: Record<string, unknown> = {};

    try {
      const res = await fetch(`/api/billing/${period.id}/url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data = await res.json();

      if (!res.ok || !data.redirectUrl) {
        const msg = data.error ?? `Request failed (${res.status})`;
        setUrlFeedback({ periodId: period.id, kind: "error", message: msg });
      } else {
        await navigator.clipboard.writeText(data.redirectUrl);
        setUrlFeedback({
          periodId: period.id,
          kind: "success",
          message: "URL copied to clipboard",
        });
      }
    } catch (err) {
      setUrlFeedback({
        periodId: period.id,
        kind: "error",
        message: err instanceof Error ? err.message : "Request failed",
      });
    } finally {
      setGeneratingUrlPeriodId(null);
      window.setTimeout(() => {
        setUrlFeedback((current) =>
          current?.periodId === period.id ? null : current,
        );
      }, 2500);
    }
  }

  // ConfirmDialog state for delete
  const [deletingPeriod, setDeletingPeriod] = useState<BillingPeriod | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  function openDeleteDialog(period: BillingPeriod) {
    setDeletingPeriod(period);
    setDeleteDialogOpen(true);
  }

  async function handleDeletePeriod() {
    if (!deletingPeriod) return;
    const { error: deleteError } = await supabase
      .from("billing_periods")
      .delete()
      .eq("id", deletingPeriod.id);
    if (deleteError) {
      throw new Error(deleteError.message);
    }
    router.refresh();
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!startDate || !endDate) {
      setError("Start and end dates are required");
      return;
    }

    if (startDate > endDate) {
      setError("Start date must be on or before end date");
      return;
    }

    setCreating(true);

    const { data: newPeriod, error: insertError } = await supabase
      .from("billing_periods")
      .insert({
        microgrid_id: microgridId,
        start_date: startDate,
        end_date: endDate,
        status: "draft",
      })
      .select("id")
      .single();

    if (insertError) {
      setError(insertError.message);
      setCreating(false);
      return;
    }

    setCreating(false);
    router.push(`/microgrids/${microgridId}/billing/${newPeriod.id}`);
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {/* Delete Period ConfirmDialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete period?"
        description={
          deletingPeriod
            ? deletingPeriod.status === "closed"
              ? "This permanently removes the closed billing period and all its finalized bills. This cannot be undone."
              : "This removes the draft billing period and any generated bills. This cannot be undone."
            : "This action cannot be undone."
        }
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={handleDeletePeriod}
      />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Billing Periods</h2>
        {/* PeriodPicker replaces the standalone "New Period" button.
            currentId is undefined — the index page has no "current" period to highlight. */}
        <PeriodPicker
          periods={periods.map((p) => toPeriodOption(p, summaries))}
          currentId={undefined}
          onSelect={(option) => router.push(`/microgrids/${microgridId}/billing/${option.id}`)}
          onNewPeriod={() => setShowCreateForm(true)}
        />
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {error}
        </div>
      )}

      {showCreateForm && (
        <form
          onSubmit={handleCreate}
          className="mb-4 space-y-3 rounded-md border border-border bg-muted p-4"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-foreground">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-foreground">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:outline-none"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? "Creating..." : "Create Period"}
          </button>
        </form>
      )}

      {periods.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No billing periods yet. Create a new period to get started.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="pb-2 pr-4 font-medium text-muted-foreground">
                  Date Range
                </th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground">Status</th>
                <th className="pb-2 pr-4 text-right font-medium text-muted-foreground">Total kWh</th>
                <th className="pb-2 pr-4 text-right font-medium text-muted-foreground">Total ({currency})</th>
                <th className="pb-2 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.id} className="border-b border-border">
                  <td className="py-3 pr-4 text-foreground">
                    {period.start_date === period.end_date ? (
                      <LocalDate value={period.start_date + "T00:00:00"} />
                    ) : (
                      <>
                        <LocalDate value={period.start_date + "T00:00:00"} />
                        {" – "}
                        <LocalDate value={period.end_date + "T00:00:00"} />
                      </>
                    )}
                  </td>
                  <td className="py-3 pr-4">
                    <StatusChip kind="billingPeriod" status={period.status} />
                  </td>
                  <td className="py-3 pr-4 text-right text-foreground">
                    {summaries[period.id] ? (
                      <Kwh value={summaries[period.id]!.totalKwh} bareNumber />
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right text-foreground">
                    {summaries[period.id] ? (
                      <Currency value={summaries[period.id]!.totalAmount} bareNumber />
                    ) : (
                      "N/A"
                    )}
                  </td>
                  <td className="py-3">
                    <Link
                      href={`/microgrids/${microgridId}/billing/${period.id}`}
                      className="rounded-md px-2 py-1 text-sm text-primary hover:bg-accent"
                    >
                      View
                    </Link>
                    <button
                      onClick={() => openDeleteDialog(period)}
                      className="rounded-md px-2 py-1 text-sm text-destructive hover:bg-destructive-muted disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      Delete
                    </button>
                    <span className="relative inline-block">
                      <button
                        onClick={() => handleGetBillingUrl(period)}
                        disabled={generatingUrlPeriodId === period.id}
                        className="rounded-md px-2 py-1 text-sm text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {generatingUrlPeriodId === period.id
                          ? "Getting URL..."
                          : "Get Billing URL"}
                      </button>
                      {urlFeedback?.periodId === period.id && (
                        <span
                          role="status"
                          className={`pointer-events-none absolute left-1/2 top-full z-10 mt-1 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-xs text-white shadow-lg ${
                            urlFeedback.kind === "success"
                              ? "bg-gray-900"
                              : "bg-red-600"
                          }`}
                        >
                          {urlFeedback.message}
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
