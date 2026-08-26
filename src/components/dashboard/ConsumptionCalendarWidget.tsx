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
// Data: daily kWh from OpenEMS energy results, aggregated day-wise by the
// applicable timezone server-side (#359 live-vs-stamped split — see the
// dashboard page's daily-energy block). NOT sourced from meter_readings
// (empty table).

"use client";

import { ConsumptionCalendar, type ConsumptionDay } from "@/components/ui/consumption-calendar";
import { formatTimezone } from "@/components/format/timezone";
import { LocalDate } from "@/components/format/local-date";

export type DailyEnergyPoint = {
  /** ISO date string YYYY-MM-DD */
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
  /**
   * #359 — "today" in the microgrid's live timezone (YYYY-MM-DD), computed
   * server-side. Drives the future-day cutoff; without it a UTC slice
   * marks the operator's current local day as "future" east of UTC.
   * Optional for backward compatibility — absent falls back to the UTC day.
   */
  todayDate?: string;
  /**
   * #359 — present when the strip crosses a timezone change: days up to
   * and including `lastStampedDate` are binned in the closed period's
   * stamped zone, later days in the live zone. Rendered as an axis
   * annotation (Architect guardrail: mark the change, never re-bin a
   * period to a uniform zone to hide it).
   */
  zoneBoundary?: {
    lastStampedDate: string;
    stampedTz: string;
    liveTz: string;
  } | null;
};

export function ConsumptionCalendarWidget({
  windowDates,
  energyByDate,
  targetDailyKwh,
  todayDate,
  zoneBoundary,
}: ConsumptionCalendarWidgetProps) {
  const todayStr = todayDate ?? new Date().toISOString().slice(0, 10);

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
      {zoneBoundary && (
        <p
          data-testid="consumption-calendar-zone-boundary"
          className="mt-2 text-[11px] text-muted-foreground"
        >
          Days through{" "}
          <LocalDate value={zoneBoundary.lastStampedDate + "T00:00:00"} /> are
          shown in {formatTimezone(zoneBoundary.stampedTz)} (that closed
          period&apos;s billing zone); later days in{" "}
          {formatTimezone(zoneBoundary.liveTz)}.
        </p>
      )}
    </section>
  );
}
