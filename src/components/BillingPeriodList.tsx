"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import type { BillingPeriod } from "@/lib/types/database";

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

function formatDate(dateStr: string) {
  return new Date(dateStr + "T00:00:00").toLocaleDateString("en", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function formatKwh(value: number): string {
  return new Intl.NumberFormat("en", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}

function formatAmount(value: number): string {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(value);
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
  const [deletingPeriodId, setDeletingPeriodId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDeletePeriod(period: BillingPeriod) {
    const dateRange = period.start_date === period.end_date
      ? formatDate(period.start_date)
      : `${formatDate(period.start_date)} – ${formatDate(period.end_date)}`;
    const message =
      period.status === "closed"
        ? `Permanently delete this closed billing period (${dateRange}) and all its finalized bills? This cannot be undone.`
        : `Delete this draft billing period (${dateRange}) and any generated bills? This cannot be undone.`;
    if (!confirm(message)) return;
    setError(null);
    setDeletingPeriodId(period.id);
    const { error: deleteError } = await supabase
      .from("billing_periods")
      .delete()
      .eq("id", period.id);
    if (deleteError) {
      setError(deleteError.message);
      setDeletingPeriodId(null);
      return;
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
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Billing Periods</h2>
        <button
          onClick={() => setShowCreateForm(!showCreateForm)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
        >
          {showCreateForm ? "Cancel" : "New Period"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {showCreateForm && (
        <form
          onSubmit={handleCreate}
          className="mb-4 space-y-3 rounded-md border border-gray-200 bg-gray-50 p-4"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="block text-sm font-medium text-gray-700">
                Start Date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">
                End Date
              </label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                required
                className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={creating}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {creating ? "Creating..." : "Create Period"}
          </button>
        </form>
      )}

      {periods.length === 0 ? (
        <p className="text-sm text-gray-500">
          No billing periods yet. Create a new period to get started.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-gray-200">
                <th className="pb-2 pr-4 font-medium text-gray-700">
                  Date Range
                </th>
                <th className="pb-2 pr-4 font-medium text-gray-700">Status</th>
                <th className="pb-2 pr-4 text-right font-medium text-gray-700">Total kWh</th>
                <th className="pb-2 pr-4 text-right font-medium text-gray-700">Total ({currency})</th>
                <th className="pb-2 font-medium text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((period) => (
                <tr key={period.id} className="border-b border-gray-100">
                  <td className="py-3 pr-4 text-gray-900">
                    {period.start_date === period.end_date
                      ? formatDate(period.start_date)
                      : <>{formatDate(period.start_date)} &ndash; {formatDate(period.end_date)}</>}
                  </td>
                  <td className="py-3 pr-4">
                    <span
                      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${
                        period.status === "closed"
                          ? "bg-green-100 text-green-800"
                          : "bg-yellow-100 text-yellow-800"
                      }`}
                    >
                      {period.status}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right text-gray-900">
                    {summaries[period.id]
                      ? formatKwh(summaries[period.id].totalKwh)
                      : "0"}
                  </td>
                  <td className="py-3 pr-4 text-right text-gray-900">
                    {summaries[period.id]
                      ? formatAmount(summaries[period.id].totalAmount)
                      : "N/A"}
                  </td>
                  <td className="py-3">
                    <Link
                      href={`/microgrids/${microgridId}/billing/${period.id}`}
                      className="rounded-md px-2 py-1 text-sm text-blue-600 hover:bg-blue-50"
                    >
                      View
                    </Link>
                    <button
                      onClick={() => handleDeletePeriod(period)}
                      disabled={deletingPeriodId === period.id}
                      className="rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {deletingPeriodId === period.id ? "Deleting..." : "Delete"}
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
