// Currency — locale + currency-aware monetary formatter.
//
// Contract:
//   - Reads locale + currency from LocaleContext by default; both can be
//     overridden via props.
//   - Intl.NumberFormat is memoized per (locale, currency, opts) pair —
//     constructor allocation is expensive at table scale (3,960 cells).
//   - `maxFractionDigits` is OPTIONAL — Intl picks sensible defaults
//     (UGX = 0, USD = 2). Override only when the data calls for it.
//   - `bareNumber` — when true, renders just the decimal number with no
//     currency symbol (style: "decimal", 0 fraction digits). Switches the
//     formatter options; does NOT post-process the string. Use for URA
//     paste workflows where the cell value is digits only.
//   - className is composable via cn() so callers can override sizing/tone.
//
// String helper:
//   - `formatCurrency(value, locale, currency, opts?)` — pure function,
//     no React context. Reuses the same getNF() cache. Returns "—" for null.

import * as React from "react";
import { cn } from "@/lib/utils";
import { useLocale } from "./locale-context";

const cache = new Map<string, Intl.NumberFormat>();
function getNF(locale: string, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = `${locale}|${JSON.stringify(opts)}`;
  let nf = cache.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(locale, opts);
    cache.set(key, nf);
  }
  return nf;
}

/** Pure string formatter — no React context. Pass locale/currency from useLocale(). */
export function formatCurrency(
  value: number | null,
  locale: string,
  currency: string,
  opts: {
    bareNumber?: boolean;
    maxFractionDigits?: number;
    minFractionDigits?: number;
  } = {},
): string {
  if (value == null) return "—";
  let nfOpts: Intl.NumberFormatOptions;
  if (opts.bareNumber) {
    nfOpts = { style: "decimal", maximumFractionDigits: 0, minimumFractionDigits: 0 };
  } else {
    nfOpts = { style: "currency", currency };
    if (opts.maxFractionDigits !== undefined) nfOpts.maximumFractionDigits = opts.maxFractionDigits;
    if (opts.minFractionDigits !== undefined) nfOpts.minimumFractionDigits = opts.minFractionDigits;
  }
  return getNF(locale, nfOpts).format(value);
}

export interface CurrencyProps extends React.HTMLAttributes<HTMLSpanElement> {
  value: number;
  /** Override the locale from LocaleContext. */
  locale?: string;
  /** Override the currency code from LocaleContext (e.g. "USD", "UGX"). */
  currency?: string;
  /** If unset, Intl picks the standard fraction count for the currency. */
  maxFractionDigits?: number;
  minFractionDigits?: number;
  /** When true, render just the decimal number — no currency symbol.
   *  Switches style to "decimal" with 0 fraction digits. Do NOT string-strip. */
  bareNumber?: boolean;
}

export function Currency({
  value,
  locale,
  currency,
  maxFractionDigits,
  minFractionDigits,
  bareNumber = false,
  className,
  ...props
}: CurrencyProps) {
  const ctx = useLocale();
  const lc = locale ?? ctx.locale;
  const cc = currency ?? ctx.currency;

  return (
    <span className={cn("font-mono tabular-nums", className)} {...props}>
      {formatCurrency(value, lc, cc, { bareNumber, maxFractionDigits, minFractionDigits })}
    </span>
  );
}
