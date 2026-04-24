/**
 * state.ts — Payment-status state machine for manual operator transitions.
 *
 * This module owns the MANUAL-OPERATOR tier of the billing_line_item payment
 * state machine. IPN-driven transitions (automated by Pesapal webhook) are
 * #121's domain — they will extend ALLOWED_MANUAL_TRANSITIONS at that time.
 *
 * ── PaymentStatus ─────────────────────────────────────────────────────────────
 *
 * Mirrors the `billing_line_item_payment_status` Postgres enum (migration 00021).
 * Keep in sync with `src/lib/types/domain.ts:BillingLineItemPaymentStatus`.
 * If the enum gains values (e.g. 'link_generated' in #121), add them here.
 *
 * ── Allowed manual transitions ────────────────────────────────────────────────
 *
 * The full 4×4 matrix (pinned in issue #124 section B):
 *
 *   From → To   | unpaid | paid  | failed | refunded
 *   ------------|--------|-------|--------|----------
 *   unpaid      | no_op  | ALLOW | inval  | inval
 *   paid        | ALLOW  | no_op | inval  | inval
 *   failed      | inval  | ALLOW | no_op  | inval
 *   refunded    | inval  | inval | inval  | no_op
 *
 * 'refunded' is terminal — no manual transitions out. 'failed → paid' is
 * the operator override for a Pesapal IPN failure (the row landed in 'failed'
 * via IPN, operator confirms cash was collected).
 *
 * Transitions INTO 'failed' or 'refunded' are IPN / refund-flow domain and are
 * additionally blocked at the PATCH route's Zod body layer (body only accepts
 * 'unpaid'|'paid'), so the matrix never sees them from a manual PATCH. The
 * matrix entries are still encoded here so the function remains authoritative
 * for all callers (including future IPN route that may call assertValidManualTransition
 * or a sibling assertValidIpnTransition that reuses this file).
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * All possible payment statuses for a billing_line_items row.
 * Mirrors `billing_line_item_payment_status` Postgres enum (migration 00021).
 */
export type PaymentStatus = "unpaid" | "paid" | "failed" | "refunded";

/** A directed state transition pair. */
export type ManualPaymentTransition = {
  from: PaymentStatus;
  to: PaymentStatus;
};

// ── Allowed transitions ───────────────────────────────────────────────────────

/**
 * Exhaustive list of transitions an operator may manually trigger.
 * Three pairs: unpaid→paid (mark as paid), paid→unpaid (correction),
 * failed→paid (operator override of a failed IPN).
 */
export const ALLOWED_MANUAL_TRANSITIONS: readonly ManualPaymentTransition[] = [
  { from: "unpaid", to: "paid" },
  { from: "paid", to: "unpaid" },
  { from: "failed", to: "paid" },
] as const;

// ── Error class ───────────────────────────────────────────────────────────────

/** Reason codes for manual-transition rejections. */
export type PaymentTransitionErrorReason = "no_op" | "invalid_transition";

/**
 * Thrown by `assertValidManualTransition` when a transition is not allowed.
 * Parallel to `PaymentError` (src/lib/payments/errors.ts) — same shape,
 * separate class so callers can distinguish transition errors from
 * provider errors without instanceof ambiguity.
 */
export class PaymentTransitionError extends Error {
  readonly reason: PaymentTransitionErrorReason;
  readonly httpStatus: 400;

  constructor(reason: PaymentTransitionErrorReason, message: string) {
    super(message);
    this.name = "PaymentTransitionError";
    this.reason = reason;
    this.httpStatus = 400;
  }
}

// ── Guard ─────────────────────────────────────────────────────────────────────

/**
 * Assert that a manual operator transition from `from` to `to` is valid.
 *
 * Throws `PaymentTransitionError` with:
 *   - reason: 'no_op'             — same-to-same state (from === to)
 *   - reason: 'invalid_transition' — valid from/to but not in allowed set,
 *                                    or a terminal state like 'refunded'
 *
 * Pure function — no DB access. Testable in isolation.
 */
export function assertValidManualTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): void {
  // Same-state is always a no-op, regardless of which state.
  if (from === to) {
    throw new PaymentTransitionError(
      "no_op",
      `Bill is already in state '${from}'.`,
    );
  }

  // Check against the allowed-transitions list.
  const allowed = ALLOWED_MANUAL_TRANSITIONS.some(
    (t) => t.from === from && t.to === to,
  );

  if (!allowed) {
    throw new PaymentTransitionError(
      "invalid_transition",
      `Manual transition from '${from}' to '${to}' is not permitted.`,
    );
  }
}
