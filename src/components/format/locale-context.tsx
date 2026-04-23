"use client";

// LocaleContext — threads locale + currency through the format primitives.
//
// Contract:
//   - Components in this app read locale + default currency from this
//     context. Each format primitive accepts a `locale`/`currency` prop
//     override path, but defaults to the context.
//   - The microgrid record carries the currency (UGX/USD/etc.); the
//     entrepreneur sets it. The locale defaults to "en" but the tenant
//     portal will pick this up from the household's preferred language.
//   - Don't auto-format per browser locale. The currency is a
//     deliberate per-microgrid decision, not a viewer-side preference.
//     (See designer-context.md anti-pattern.)

import * as React from "react";

export type LocaleValue = {
  locale: string;
  currency: string;
};

const LocaleContext = React.createContext<LocaleValue>({
  locale: "en",
  currency: "UGX",
});

export function LocaleProvider({
  locale = "en",
  currency = "UGX",
  children,
}: {
  locale?: string;
  currency?: string;
  children: React.ReactNode;
}) {
  const value = React.useMemo(() => ({ locale, currency }), [locale, currency]);
  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleValue {
  return React.useContext(LocaleContext);
}
