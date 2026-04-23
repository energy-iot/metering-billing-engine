/**
 * currency.ts — ISO 4217 currency validation.
 *
 * UI restricts the microgrid currency Select to UGX/USD/EUR/KES/RWF/TZS, but
 * the server accepts any valid ISO 4217 code — the runtime catches a
 * `RangeError` for unknown codes via `Intl.NumberFormat`. This means a future
 * microgrid in a new country (e.g. SSP) can be created server-side without
 * changing the UI allowlist immediately.
 */

/**
 * Validates a currency string via `Intl.NumberFormat`. Returns an error
 * message if invalid, or null if valid.
 *
 * `Intl.NumberFormat('en', { style: 'currency', currency: input })` throws
 * `RangeError` for any non-ISO-4217 code (e.g. 'FOO', 'XYZ', ''). We catch
 * and translate into a user-facing 422 message.
 */
export function validateCurrency(input: string): string | null {
  if (!input) return "Currency is required.";
  try {
    new Intl.NumberFormat("en", { style: "currency", currency: input }).format(
      0
    );
    return null;
  } catch {
    return `Invalid currency code: '${input}'.`;
  }
}

/** UI-facing allowlist. Server accepts any valid ISO 4217 code. */
export const CURRENCY_OPTIONS = [
  "UGX",
  "USD",
  "EUR",
  "KES",
  "RWF",
  "TZS",
] as const;

export type CurrencyOption = (typeof CURRENCY_OPTIONS)[number];
