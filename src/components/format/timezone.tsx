// Timezone — IANA timezone formatter (#356, tz-awareness anchor #353).
//
// Contract:
//   - Renders "IANA id + current UTC offset", e.g. "Africa/Kampala (UTC+3)".
//     Never offset-only (loses DST identity), never abbreviation-only
//     ("CST" names three different zones).
//   - The offset is derived from the IANA id via Intl.DateTimeFormat with
//     timeZoneName: "shortOffset" — no hardcoded offset table. For DST
//     zones the offset therefore depends on the reference date (e.g.
//     Europe/Berlin is UTC+2 in July, UTC+1 in January).
//   - Intl.DateTimeFormat memoized per IANA id (formatter is date-free;
//     the reference date is applied per call via formatToParts).
//   - className composable via cn().
//
// String helper:
//   - `formatTimezone(iana, referenceDate?)` — pure function, no React
//     context. Returns "—" for null / undefined / unknown IANA ids (the
//     Intl constructor throws RangeError on bad ids; a corrupt stored
//     timezone must not 500 the caller's UI — mirrors formatLocalDate's
//     Invalid Date fallback). `referenceDate` defaults to the current
//     instant; tests and any caller needing determinism MUST pass an
//     explicit Date. Mirrors the formatCurrency / formatLocalDate shipping
//     pattern so non-DOM consumers (e.g. the @react-pdf invoice renderer
//     at src/lib/invoices/render.tsx — react-pdf can't render <span>) get
//     the exact same string.

import * as React from "react";
import { cn } from "@/lib/utils";

const cache = new Map<string, Intl.DateTimeFormat>();
function getTZF(iana: string): Intl.DateTimeFormat {
  let df = cache.get(iana);
  if (!df) {
    // Locale is pinned to "en" — the output we consume ("GMT+3") is a
    // numeric offset token, and pinning keeps the rendered string
    // identical across viewer locales (one formatter, one string).
    df = new Intl.DateTimeFormat("en", {
      timeZone: iana,
      timeZoneName: "shortOffset",
    });
    cache.set(iana, df);
  }
  return df;
}

/**
 * Pure string formatter — no React context.
 *
 * Returns "IANA id (UTC±offset)", e.g. "Africa/Kampala (UTC+3)",
 * "UTC (UTC+0)", "Asia/Kolkata (UTC+5:30)". For DST zones the offset
 * reflects `referenceDate` (defaults to now — pass an explicit Date for
 * deterministic output, e.g. in tests or when rendering a stored period).
 * Returns "—" for null / undefined / unrecognized IANA ids.
 */
export function formatTimezone(
  iana: string | null | undefined,
  referenceDate?: Date,
): string {
  if (iana == null || iana === "") return "—";
  const ref = referenceDate ?? new Date();
  if (Number.isNaN(ref.getTime())) return "—";
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = getTZF(iana).formatToParts(ref);
  } catch {
    // RangeError: invalid time zone — corrupt stored value; degrade, don't throw.
    return "—";
  }
  const token = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  // "GMT+3" / "GMT+5:30" / "GMT-4" / bare "GMT" (zero offset) → "UTC±h[:mm]".
  const offset = token === "GMT" ? "UTC+0" : token.replace(/^GMT/, "UTC");
  return `${iana} (${offset})`;
}

export interface TimezoneProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** IANA timezone id, e.g. "Africa/Kampala". */
  iana: string;
  /** Date at which to evaluate the UTC offset (matters for DST zones). Defaults to now. */
  referenceDate?: Date;
}

export function Timezone({ iana, referenceDate, className, ...props }: TimezoneProps) {
  return (
    <span className={cn(className)} {...props}>
      {formatTimezone(iana, referenceDate)}
    </span>
  );
}
