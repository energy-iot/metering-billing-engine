// Health-derivation helper for the community Payment tab (#119).
//
// Derives a PaymentHealth state from the community's payment_* fields. This
// helper is PURE — no DB access. The layout + page each fetch the row and
// hand the result to this function.
//
// State table (AC-HEALTH-1):
//
//   payment_provider IS NULL                          → not_configured
//   payment_last_configured_at < 24h ago              → healthy
//   payment_last_configured_at >= 24h ago (or null)   → stale
//
// Note: the `failing` state is RESERVED for #121 (IPN registration +
// webhook failure tracking). `derivePaymentHealth` never returns `failing`
// today — migration 00020 has no `payment_last_status` column to source it
// from. The `failing` entry still lives in `StatusChip MAPS.paymentHealth`
// (Designer locked the tone table in #117 so the MAPS are stable across
// the deferred IPN rollout).

export type PaymentHealth =
  | "healthy"
  | "stale"
  | "failing"
  | "not_configured";

export type PaymentHealthInput = {
  payment_provider: "pesapal" | null;
  payment_last_configured_at: string | null;
} | null;

const TWENTY_FOUR_HOURS_MS = 24 * 3600 * 1000;

export function derivePaymentHealth(
  row: PaymentHealthInput,
  now: Date = new Date(),
): PaymentHealth {
  if (!row) return "not_configured";
  if (!row.payment_provider) return "not_configured";

  if (!row.payment_last_configured_at) return "stale";

  const at = new Date(row.payment_last_configured_at).getTime();
  if (Number.isNaN(at)) return "stale";
  const diff = now.getTime() - at;
  return diff < TWENTY_FOUR_HOURS_MS ? "healthy" : "stale";
}
