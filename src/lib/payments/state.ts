/**
 * state.ts — Payment-status state machine for manual + IPN transitions.
 *
 * This module is a pure-TS mirror of the SQL state machine encoded in
 * `fn_apply_payment_event` (migration 00027). The DB function is authoritative
 * — these helpers are application-layer pre-flight guards so routes can
 * surface 400 invalid_transition / no_op responses without round-tripping to
 * the DB. Keep both in sync.
 *
 * ── PaymentStatus ─────────────────────────────────────────────────────────────
 *
 * Mirrors the `billing_line_item_payment_status` Postgres enum (migrations
 * 00021 + 00027). Keep in sync with `src/lib/types/domain.ts:BillingLineItemPaymentStatus`.
 *
 * ── Allowed manual transitions (Phase B widening) ─────────────────────────────
 *
 *   From → To       | unpaid | paid  | failed | refunded | link_generated
 *   ----------------|--------|-------|--------|----------|---------------
 *   unpaid          | no_op  | ALLOW | inval  | inval    | inval
 *   paid            | ALLOW  | no_op | inval  | ALLOW    | inval
 *   failed          | inval  | ALLOW | no_op  | inval    | inval
 *   refunded        | inval  | inval | inval  | no_op    | inval
 *   link_generated  | ALLOW  | ALLOW | ALLOW  | inval    | no_op
 *
 * 'refunded' is terminal in the manual matrix (operators record refunds via
 * paid → refunded, not the other way around). 'link_generated' is intermediate
 * — operators may cancel a pending link (link_generated → unpaid), record an
 * out-of-band payment (link_generated → paid), or mark a failed attempt
 * (link_generated → failed).
 *
 * ── IPN transitions ───────────────────────────────────────────────────────────
 *
 * IPN-driven transitions are a sibling matrix (see `assertValidIpnTransition`):
 *   link_generated → paid | failed
 *   unpaid         → paid | failed   (defensive — link regeneration races)
 *   paid           → refunded
 *
 * ── generate_link transitions ─────────────────────────────────────────────────
 *
 * `unpaid → link_generated` (initial generation) and `link_generated →
 * link_generated` (regenerate after abandoned attempt) — the SQL function
 * handles regenerate as an audit-only event.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * All possible payment statuses for a billing_line_items row.
 * Mirrors `billing_line_item_payment_status` Postgres enum (migrations
 * 00021 + 00027 — `link_generated` added in 00027).
 */
export type PaymentStatus =
  | "unpaid"
  | "paid"
  | "failed"
  | "refunded"
  | "link_generated";

/** A directed state transition pair. */
export type ManualPaymentTransition = {
  from: PaymentStatus;
  to: PaymentStatus;
};

// ── Allowed transitions ───────────────────────────────────────────────────────

/**
 * Exhaustive list of transitions an operator may manually trigger.
 * Pairs:
 *   unpaid → paid                 — standard mark-paid
 *   paid → unpaid                 — operator correction
 *   failed → paid                 — operator override of a failed IPN
 *   paid → refunded               — operator records out-of-band refund
 *   link_generated → unpaid       — cancel pending link
 *   link_generated → paid         — record out-of-band payment
 *   link_generated → failed       — record failed attempt
 */
export const ALLOWED_MANUAL_TRANSITIONS: readonly ManualPaymentTransition[] = [
  { from: "unpaid", to: "paid" },
  { from: "paid", to: "unpaid" },
  { from: "failed", to: "paid" },
  { from: "paid", to: "refunded" },
  { from: "link_generated", to: "unpaid" },
  { from: "link_generated", to: "paid" },
  { from: "link_generated", to: "failed" },
] as const;

/**
 * Allowed IPN-driven transitions. Mirrors the matrix encoded in
 * `fn_apply_payment_event` (migration 00027 §6) for source='ipn'.
 *
 * `unpaid → paid|failed` is included defensively for the case where a Pesapal
 * IPN arrives before the link-route's `unpaid → link_generated` event has
 * been written (network reorder; SQL function row-locks resolve this, but
 * the application-layer guard wants to admit the transition).
 */
export const ALLOWED_IPN_TRANSITIONS: readonly ManualPaymentTransition[] = [
  { from: "link_generated", to: "paid" },
  { from: "link_generated", to: "failed" },
  { from: "unpaid", to: "paid" },
  { from: "unpaid", to: "failed" },
  { from: "paid", to: "refunded" },
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

/**
 * Assert that an IPN-driven transition from `from` to `to` is valid.
 *
 * Same shape as `assertValidManualTransition`, distinct matrix. Thrown
 * `invalid_transition` is mapped to a no-op + 200-ack by the IPN route (we
 * never 5xx a webhook — see route header comment).
 *
 * Pure function — no DB access. The DB function `fn_apply_payment_event` is
 * the authoritative re-validator under row lock.
 */
export function assertValidIpnTransition(
  from: PaymentStatus,
  to: PaymentStatus,
): void {
  if (from === to) {
    throw new PaymentTransitionError(
      "no_op",
      `IPN no-op: line item already in state '${from}'.`,
    );
  }
  const allowed = ALLOWED_IPN_TRANSITIONS.some(
    (t) => t.from === from && t.to === to,
  );
  if (!allowed) {
    throw new PaymentTransitionError(
      "invalid_transition",
      `IPN transition from '${from}' to '${to}' is not permitted.`,
    );
  }
}
