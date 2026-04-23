// ConsumptionCalendarWidget — 30-day microgrid-wide consumption calendar.
//
// TARGET FORMULA:
//   target_daily_kwh = sum(line_items.usage_kwh for previous closed period)
//                      / period_day_count
//
//   period_day_count = date diff between end_date and start_date (inclusive).
//
//   Fallback to mode="absolute" (no target) when:
//     - previous closed period had fewer than 7 days, OR
//     - no line-item data found for that period (sum = 0 and no items).
//
//   When a target is available, each day's pct = kwh / target_daily_kwh.
//   Days with no OpenEMS data render with status="missing".
//   Future days (beyond today) render with status="future".
//
// Data: daily kWh from OpenEMS energy results, aggregated by UTC day client-side.
// NOT sourced from meter_readings (empty table).

"use client";

import { ConsumptionCalendar, type ConsumptionDay } from "@/components/ui/consumption-calendar";

export type DailyEnergyPoint = {
  /** ISO date string YYYY-MM-DD (UTC) */
  date: string;
  /** total kWh across all edges for that day */
  kwh: number;
};

export type ConsumptionCalendarWidgetProps = {
  /** The 30 days to display (last 30 calendar days, sorted ascending). */
  windowDates: string[]; // Array of YYYY-MM-DD strings
  /** Energy data keyed by date. Missing dates = no data. */
  energyByDate: Record<string, number>;
  /** Target daily kWh derived from previous period. Null triggers absolute mode. */
  targetDailyKwh: number | null;
};

export function ConsumptionCalendarWidget({
  windowDates,
  energyByDate,
  targetDailyKwh,
}: ConsumptionCalendarWidgetProps) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  const days: ConsumptionDay[] = windowDates.map((dateStr, i) => {
    const isFuture = dateStr > todayStr;
    if (isFuture) {
      return { day: i + 1, pct: null, kwh: null, status: "future" as const };
    }

    const kwh = energyByDate[dateStr] ?? null;
    if (kwh === null) {
      return { day: i + 1, pct: null, kwh: null, status: "missing" as const };
    }

    // pct relative to target (null when no target → absolute mode)
    const pct = targetDailyKwh !== null && targetDailyKwh > 0
      ? kwh / targetDailyKwh
      : null;

    return { day: i + 1, pct, kwh };
  });

  const mode = targetDailyKwh !== null ? "relative" : "absolute";

  return (
    <section
      aria-label="30-day consumption calendar"
      className="rounded-lg border border-border bg-card px-4 py-3"
    >
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        Consumption (last 30 days)
      </p>
      <ConsumptionCalendar days={days} mode={mode} />
    </section>
  );
}
