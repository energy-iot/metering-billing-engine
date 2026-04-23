// OpenPeriodSummary — 5-cell summary strip for the current open billing period.
//
// PROJECTED TOTAL FORMULA:
//   projected_kwh = running_usage_kwh * (period_days / elapsed_days)
//   projected_amount = projected_kwh * effective_rate_per_kwh
//
//   period_days  = date diff between end_date and start_date (inclusive) in days
//   elapsed_days = date diff between today and start_date (inclusive), floored at 1
//                  to avoid division by zero on the first day.
//
// If no open draft period exists, renders a CTA Banner linking to the Billing tab.

"use client";

import Link from "next/link";
import { Banner } from "@/components/ui/banner";
import { Currency } from "@/components/format/currency";
import { Kwh } from "@/components/format/kwh";

export type OpenPeriodSummaryProps = {
  microgridId: string;
  period: {
    id: string;
    start_date: string;
    end_date: string;
    householdsCount: number;
    totalUsageKwh: number;
    totalAmount: number;
    projectedUsageKwh: number;
    projectedAmount: number;
  } | null;
};

export function OpenPeriodSummary({ microgridId, period }: OpenPeriodSummaryProps) {
  if (!period) {
    return (
      <Banner
        tone="info"
        title="No open period"
        action={
          <Link
            href={`/microgrids/${microgridId}/billing`}
            className="text-sm font-medium underline hover:opacity-80"
          >
            Create one →
          </Link>
        }
      >
        No open billing period found. Start a new billing period to track
        household consumption.
      </Banner>
    );
  }

  const today = new Date();
  const start = new Date(period.start_date);
  const end = new Date(period.end_date);

  const periodDays =
    Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;
  const daysRemaining = Math.max(
    0,
    Math.round((end.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))
  );

  return (
    <section
      aria-label="Open period summary"
      className="rounded-lg border border-border bg-card px-4 py-3"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Open period &mdash; {period.start_date} to {period.end_date}
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <SummaryCell label="Households" value={String(period.householdsCount)} />
        <SummaryCell
          label="kWh so far"
          value={<Kwh value={period.totalUsageKwh} digits={1} />}
        />
        <SummaryCell
          label="Running total"
          value={<Currency value={period.totalAmount} />}
        />
        <SummaryCell
          label="Projected total"
          value={<Currency value={period.projectedAmount} />}
        />
        <SummaryCell
          label={`Days remaining (of ${periodDays})`}
          value={String(daysRemaining)}
        />
      </div>
    </section>
  );
}

function SummaryCell({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="text-base font-semibold text-foreground">{value}</span>
    </div>
  );
}
