"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { BillingPeriod } from "@/lib/types/database";
import { StatusChip } from "@/components/ui/status-chip";
import { Currency } from "@/components/format/currency";
import { Kwh } from "@/components/format/kwh";
import { LocalDate } from "@/components/format/local-date";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

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
  summaries: Record<string, { totalKwh: number; totalAmount: number }>;
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
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          {showCreateForm ? "Cancel" : "New Period"}
        </button>
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
                      <Kwh value={summaries[period.id].totalKwh} bareNumber />
                    ) : (
                      "0"
                    )}
                  </td>
                  <td className="py-3 pr-4 text-right text-foreground">
                    {summaries[period.id] ? (
                      <Currency value={summaries[period.id].totalAmount} bareNumber />
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
