// TopHouseholdsLeaderboard — top-3 households by kWh in the current open period.
//
// Shows: rank, household name (static text — no deep link per ticket spec),
// kWh usage, running UGX amount, and % of microgrid total.
//
// Empty state (zero line items): muted "No readings in the current period yet."
// No open period: renders nothing (caller guards on period existence).

"use client";

import { Kwh } from "@/components/format/kwh";
import { Currency } from "@/components/format/currency";

export type LeaderboardEntry = {
  householdId: string;
  householdName: string;
  usageKwh: number;
  totalAmount: number;
};

export type TopHouseholdsLeaderboardProps = {
  entries: LeaderboardEntry[];
  microgridTotalKwh: number;
};

export function TopHouseholdsLeaderboard({
  entries,
  microgridTotalKwh,
}: TopHouseholdsLeaderboardProps) {
  if (entries.length === 0) {
    return (
      <section
        aria-label="Top households"
        className="rounded-lg border border-border bg-card px-4 py-3"
      >
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Top households
        </p>
        <p className="text-sm text-muted-foreground">
          No readings in the current period yet.
        </p>
      </section>
    );
  }

  const top3 = entries.slice(0, 3);

  return (
    <section
      aria-label="Top households"
      className="rounded-lg border border-border bg-card px-4 py-3"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Top households
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-[11px] text-muted-foreground">
            <th className="pb-1.5 pr-3 font-medium">#</th>
            <th className="pb-1.5 pr-3 font-medium">Household</th>
            <th className="pb-1.5 pr-3 text-right font-medium">kWh</th>
            <th className="pb-1.5 pr-3 text-right font-medium">Running total</th>
            <th className="pb-1.5 text-right font-medium">% of total</th>
          </tr>
        </thead>
        <tbody>
          {top3.map((entry, idx) => {
            const pct =
              microgridTotalKwh > 0
                ? ((entry.usageKwh / microgridTotalKwh) * 100).toFixed(1)
                : "—";
            return (
              <tr
                key={entry.householdId}
                className="border-b border-border/50 last:border-0"
              >
                <td className="py-2 pr-3 text-muted-foreground">{idx + 1}</td>
                <td className="py-2 pr-3 font-medium text-foreground">
                  {entry.householdName}
                </td>
                <td className="py-2 pr-3 text-right">
                  <Kwh value={entry.usageKwh} digits={1} />
                </td>
                <td className="py-2 pr-3 text-right">
                  <Currency value={entry.totalAmount} />
                </td>
                <td className="py-2 text-right text-muted-foreground">
                  {pct === "—" ? "—" : `${pct}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
