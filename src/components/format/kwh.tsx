// Kwh — locale-aware energy-unit formatter.
//
// Contract:
//   - Reads locale from LocaleContext; override via prop.
//   - Intl.NumberFormat memoized per (locale, digits) pair.
//   - Default digits = 1 (one decimal place — matches Aaron's URA filing
//     convention). Pass digits={3} for sub-Watt diagnostics.
//   - className composable via cn().
//
// String helper:
//   - `formatKwh(value, locale, opts?)` — pure function, no React context.
//     Reuses the same getNF() cache. Returns "—" for null.
//   - bareNumber only affects the JSX wrapper's " kWh" suffix — the string
//     helper itself never emits " kWh".

import * as React from "react";
import { cn } from "@/lib/utils";
import { useLocale } from "./locale-context";

const cache = new Map<string, Intl.NumberFormat>();
function getNF(locale: string, digits: number): Intl.NumberFormat {
  const key = `${locale}|${digits}`;
  let nf = cache.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    cache.set(key, nf);
  }
  return nf;
}

/** Pure string formatter — no React context. Pass locale from useLocale(). */
export function formatKwh(
  value: number | null,
  locale: string,
  opts: { bareNumber?: boolean; digits?: number } = {},
): string {
  if (value == null) return "—";
  const digits = opts.digits ?? 1;
  return getNF(locale, digits).format(value);
}

export interface KwhProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  locale?: string;
  digits?: number;
  /** Render just the number (no " kWh" suffix) — for table cells. */
  bareNumber?: boolean;
}

export function Kwh({
  value,
  locale,
  digits = 1,
  bareNumber = false,
  className,
  ...props
}: KwhProps) {
  const ctx = useLocale();
  const lc = locale ?? ctx.locale;
  return (
    <span className={cn("font-mono tabular-nums", className)} {...props}>
      {formatKwh(value, lc, { digits })}
      {!bareNumber && " kWh"}
    </span>
  );
}
