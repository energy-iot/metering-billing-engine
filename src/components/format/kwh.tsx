// Kwh — locale-aware energy-unit formatter.
//
// Contract:
//   - Reads locale from LocaleContext; override via prop.
//   - Intl.NumberFormat memoized per (locale, digits) pair.
//   - Default digits = 1 (one decimal place — matches Aaron's URA filing
//     convention). Pass digits={3} for sub-Watt diagnostics.
//   - className composable via cn().

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
      {getNF(lc, digits).format(value)}
      {!bareNumber && " kWh"}
    </span>
  );
}
