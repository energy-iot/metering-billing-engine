/**
 * day-key.ts — timezone-aware calendar-day keys (#359, tz-awareness
 * anchor #353).
 *
 * `dayKeyInZone(instant, timezone)` names the calendar day an instant
 * falls on IN THE GIVEN IANA ZONE, as a `YYYY-MM-DD` string. It replaces
 * the `toISOString().slice(0, 10)` idiom at day-binning sites, which
 * always names the UTC day: midnight in Kampala is 21:00 the previous
 * day in UTC, so UTC slicing bins an east-of-UTC operator's local-day
 * boundaries onto the wrong calendar cell.
 *
 * Scope guard (same HARD rule as the rest of the feature): this is a
 * binning/windowing helper for ENERGY DATA timestamps. It must never be
 * used to reinterpret a billing period's plain-DATE `start_date` /
 * `end_date` for display — those are calendar dates already and render
 * as-is.
 *
 * No numeric-offset math — the IANA name goes straight into
 * `Intl.DateTimeFormat` and ICU resolves the offset (incl. DST).
 */

const cache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timezone: string): Intl.DateTimeFormat {
  let df = cache.get(timezone);
  if (!df) {
    // en-CA renders "YYYY-MM-DD" with these options — no manual part
    // reassembly needed. Locale is pinned so the key shape is identical
    // across runtimes.
    df = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    cache.set(timezone, df);
  }
  return df;
}

/**
 * The `YYYY-MM-DD` calendar day of `instant` in `timezone` (IANA id).
 *
 * Throws RangeError on an unknown zone id — callers own validation
 * (`@/lib/validation/timezone`); an invalid id reaching a binning site
 * is a programming error, not a render-time degradation case.
 */
export function dayKeyInZone(instant: Date | number, timezone: string): string {
  return getFormatter(timezone).format(instant);
}

/**
 * Add `days` (may be negative) to a plain `YYYY-MM-DD` calendar date.
 * Pure calendar arithmetic — routed through UTC so no local/session zone
 * ever shifts the result. Used to build contiguous day axes.
 */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
