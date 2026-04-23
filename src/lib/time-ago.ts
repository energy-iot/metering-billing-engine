// time-ago — locale-aware relative-time formatter.
//
// Contract:
//   - Input: Date or string (ISO-8601 / RFC 2822 / YYYY-MM-DD) + optional locale.
//   - Output: short relative-time string like "2h ago", "3d ago", "just now",
//     or "in 5m" for future dates.
//   - Implementation: Intl.RelativeTimeFormat (CLDR-backed). No date-fns.
//   - Memoized per locale — RelativeTimeFormat construction is the expensive
//     part; reuse the instance across calls.
//
// Thresholds (seconds → unit):
//   < 60        → "just now"          (no unit plural)
//   < 3600      → "Nm ago"            (minutes)
//   < 86400     → "Nh ago"            (hours)
//   < 2592000   → "Nd ago"            (days, ≤ 30)
//   < 31536000  → "Nmo ago"           (months, ≤ 12)
//   else        → "Ny ago"            (years)
//
// We pass `style: "narrow"` to RelativeTimeFormat which produces forms like
// "2h ago" instead of "2 hours ago" — matches the designer brief.

const cache = new Map<string, Intl.RelativeTimeFormat>();

function getRTF(locale: string): Intl.RelativeTimeFormat {
  let rtf = cache.get(locale);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "narrow" });
    cache.set(locale, rtf);
  }
  return rtf;
}

/**
 * Returns a short relative-time string for the given date.
 * Negative deltas (past) render as "Nunit ago"; positive (future) as
 * "in Nunit" via `numeric: 'auto'`.
 *
 * `locale` defaults to "en" so callers inside server-only helpers (no
 * LocaleContext) can rely on a deterministic output. UI callers pass the
 * context locale explicitly.
 */
export function timeAgo(input: Date | string, locale: string = "en"): string {
  const d = input instanceof Date ? input : new Date(input);
  const now = Date.now();
  const deltaSec = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(deltaSec);

  if (abs < 60) {
    return "just now";
  }

  const rtf = getRTF(locale);

  if (abs < 3600) {
    return rtf.format(Math.round(deltaSec / 60), "minute");
  }
  if (abs < 86400) {
    return rtf.format(Math.round(deltaSec / 3600), "hour");
  }
  if (abs < 2592000) {
    return rtf.format(Math.round(deltaSec / 86400), "day");
  }
  if (abs < 31536000) {
    return rtf.format(Math.round(deltaSec / 2592000), "month");
  }
  return rtf.format(Math.round(deltaSec / 31536000), "year");
}
