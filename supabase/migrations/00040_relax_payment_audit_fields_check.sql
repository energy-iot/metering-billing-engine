-- 00040_relax_payment_audit_fields_check.sql
-- Closes #243 — relax billing_line_items_payment_audit_fields_required
-- so paid rows are no longer required to carry paid_by_user_id.
--
-- Why: Pesapal IPN webhook (src/app/api/payments/ipn/route.ts) calls
-- fn_apply_payment_event with _actor_user_id=NULL (no human actor), which
-- makes the COALESCE in the function leave paid_by_user_id NULL, violating
-- the existing constraint's "paid rows must have paid_by_user_id" arm.
-- Launch blocker for #121 (IPN webhook).
--
-- Source-of-truth audit trail lives in payment_events (source +
-- actor_user_id captured per event); the column on billing_line_items
-- was redundant for the IPN path.
--
-- Architectural rationale ("Shape C") in #243 refinement comment:
--   - Function-level enforcement (fn_apply_payment_event) remains the
--     sole writer for status transitions.
--   - RLS already restricts who can write billing_line_items.
--   - The CHECK becomes the temporal-audit invariant: paid/refunded rows
--     have paid_at NOT NULL. The "who" lives in payment_events.
--
-- Manual-mark route (PATCH /api/billing-line-items/[lineItemId]/payment-status)
-- is unaffected — it still authenticates the caller via its own auth gate
-- and passes the user_id through to fn_apply_payment_event. Defense-in-depth
-- shifts from "DB enforces user-present on paid rows" to "route + function
-- enforce flow, DB enforces temporal-audit invariant."

ALTER TABLE billing_line_items
  DROP CONSTRAINT IF EXISTS billing_line_items_payment_audit_fields_required;

ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_payment_audit_fields_required
  CHECK (
    (
      payment_status = ANY (ARRAY[
        'unpaid'::billing_line_item_payment_status,
        'failed'::billing_line_item_payment_status,
        'link_generated'::billing_line_item_payment_status
      ])
      AND paid_at IS NULL
      AND paid_by_user_id IS NULL
    )
    OR
    (
      payment_status = ANY (ARRAY[
        'paid'::billing_line_item_payment_status,
        'refunded'::billing_line_item_payment_status
      ])
      AND paid_at IS NOT NULL
    )
  );

COMMENT ON CONSTRAINT billing_line_items_payment_audit_fields_required ON billing_line_items IS
  'Temporal-audit invariant: paid/refunded rows must have paid_at. The previous "paid rows must have paid_by_user_id" arm was dropped in #243 because Pesapal IPN has no human actor; payment_events (source + actor_user_id) is the audit source-of-truth.';
