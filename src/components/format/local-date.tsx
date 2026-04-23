// LocalDate — locale-aware date formatter.
//
// Contract:
//   - Accepts a Date or a string (ISO-8601 / RFC 2822 / YYYY-MM-DD).
//     We don't sniff string length — always go through `new Date(...)`.
//   - Intl.DateTimeFormat memoized per (locale, opts) pair.
//   - Default opts = { year: numeric, month: short, day: numeric } —
//     "Mar 15, 2026" in en. Override per-call when needed.
//   - className composable via cn().

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

const DEFAULT_OPTS: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

export function LocalDate({ value, locale, opts, relative, className, ...props }: LocalDateProps) {
  const ctx = useLocale();
  const lc = locale ?? ctx.locale;
  const d = value instanceof Date ? value : new Date(value);
  const text = relative
    ? timeAgo(d, lc)
    : getDF(lc, opts ?? DEFAULT_OPTS).format(d);
  return (
    <span className={cn("font-mono tabular-nums", className)} {...props}>
      {text}
    </span>
  );
}
