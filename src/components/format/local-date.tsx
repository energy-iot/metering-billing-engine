// LocalDate — locale-aware date formatter.
//
// Contract:
//   - Accepts a Date or a string (ISO-8601 / RFC 2822 / YYYY-MM-DD).
//     We don't sniff string length — always go through `new Date(...)`.
//   - Intl.DateTimeFormat memoized per (locale, opts) pair.
//   - Default opts = { year: numeric, month: short, day: numeric } —
//     "Mar 15, 2026" in en. Override per-call when needed.
//   - className composable via cn().
//
// String helper:
//   - `formatLocalDate(value, locale, opts?)` — pure function, no React
//     context. Reuses the same getDF() cache. Returns "—" for null /
//     undefined. Mirrors the formatCurrency / formatKwh shipping pattern
//     (#46 / PR #49) so non-DOM consumers (e.g. PDF1b's @react-pdf renderer
//     at src/lib/invoices/render.tsx — react-pdf can't render <span>) get
//     consistent locale formatting without inlining Intl.DateTimeFormat.

import * as React from "react";
import { cn } from "@/lib/utils";
import { useLocale } from "./locale-context";
import { timeAgo } from "@/lib/time-ago";

const cache = new Map<string, Intl.DateTimeFormat>();
function getDF(locale: string, opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let df = cache.get(key);
  if (!df) {
    df = new Intl.DateTimeFormat(locale, opts);
    cache.set(key, df);
  }
  return df;
}

const DEFAULT_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

/** Pure string formatter — no React context. Pass locale from useLocale(). */
export function formatLocalDate(
  value: Date | string | null | undefined,
  locale: string,
  opts?: Intl.DateTimeFormatOptions,
): string {
  if (value == null) return "—";
  const d = value instanceof Date ? value : new Date(value);
  // Defensive against bad inputs — Intl throws on Invalid Date, but the
  // caller's UI shouldn't 500 over a corrupt timestamp.
  if (Number.isNaN(d.getTime())) return "—";
  return getDF(locale, opts ?? DEFAULT_OPTS).format(d);
}

export interface LocalDateProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: Date | string;
  locale?: string;
  opts?: Intl.DateTimeFormatOptions;
  /**
   * Render the value as a relative time string ("2h ago") via `timeAgo()`
   * instead of the absolute Intl.DateTimeFormat output. Added in #102 for
   * the "Last successful discovery: <relative>" summary. Mutually
   * exclusive with `opts` (ignored when `relative` is true).
   */
  relative?: boolean;
}

export function LocalDate({ value, locale, opts, relative, className, ...props }: LocalDateProps) {
  const ctx = useLocale();
  const lc = locale ?? ctx.locale;
  const d = value instanceof Date ? value : new Date(value);
  const text = relative ? timeAgo(d, lc) : formatLocalDate(d, lc, opts);
  return (
    <span className={cn("font-mono tabular-nums", className)} {...props}>
      {text}
    </span>
  );
}
