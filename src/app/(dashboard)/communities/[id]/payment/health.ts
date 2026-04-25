// Health-derivation helper for the community Payment tab (#119, #157).
//
// Derives a PaymentHealth state from the community's payment_* fields PLUS
// the most-recent payment_events failure timestamp (Phase B / #157). This
// helper is PURE — no DB access. The layout + page each fetch the row(s)
// and hand the result to this function.
//
// State table:
//
//   payment_provider IS NULL                                 → not_configured
//   recent failed IPN event within 24h                       → failing  (Phase B)
//   payment_last_configured_at < 24h ago                     → healthy
//   payment_last_configured_at >= 24h ago (or null)          → stale
//
// `failing` takes precedence over `healthy` / `stale` once a recent IPN
// failure is observed — the operator should investigate before treating the
// integration as healthy. Phase A's MAPS entry for `failing` is wired here.

export type PaymentHealth =
  | "healthy"
  | "stale"
  | "failing"
  | "not_configured";

export type PaymentHealthInput = {
  payment_provider: "pesapal" | null;
  payment_last_configured_at: string | null;
  /**
   * Phase B (#157): timestamp (ISO) of the most-recent payment_events row
   * for this community whose `to_status='failed'` AND `source='ipn'`. NULL
   * when no such event has been recorded. The page/layout queries
   * payment_events filtered by this community's microgrids and passes the
   * single timestamp here — the helper stays pure.
   */
  most_recent_failed_ipn_at?: string | null;
} | null;

const TWENTY_FOUR_HOURS_MS = 24 * 3600 * 1000;

export function derivePaymentHealth(
  row: PaymentHealthInput,
  now: Date = new Date(),
): PaymentHealth {
  if (!row) return "not_configured";
  if (!row.payment_provider) return "not_configured";

  // Phase B: a recent IPN failure flips the health to `failing` regardless of
  // the configure-time timestamp — operator must investigate.
  if (row.most_recent_failed_ipn_at) {
    const failedAt = new Date(row.most_recent_failed_ipn_at).getTime();
    if (!Number.isNaN(failedAt)) {
      const failedAge = now.getTime() - failedAt;
      if (failedAge >= 0 && failedAge < TWENTY_FOUR_HOURS_MS) {
        return "failing";
      }
    }
  }

  if (!row.payment_last_configured_at) return "stale";

  const at = new Date(row.payment_last_configured_at).getTime();
  if (Number.isNaN(at)) return "stale";
  const diff = now.getTime() - at;
  return diff < TWENTY_FOUR_HOURS_MS ? "healthy" : "stale";
}
