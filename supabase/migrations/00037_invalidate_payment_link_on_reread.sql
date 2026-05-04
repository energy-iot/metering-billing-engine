-- 00037_invalidate_payment_link_on_reread.sql
-- PDF5 follow-up (#217): re-entering manual reading kept the stale Pesapal
-- redirect link with the previous total_amount.
--
-- ── Why ───────────────────────────────────────────────────────────────────────
--
-- `fn_record_line_item_with_audit` (00029) is the canonical writer for the
-- billing_line_items UPSERT. Its DO UPDATE SET clause explicitly enumerates
-- the columns to overwrite; everything else is silently preserved. That
-- "preserve everything else" policy is correct for the payment-state machine
-- columns owned by `fn_apply_payment_event` (payment_status, paid_at,
-- paid_by_user_id, payment_notes, payment_refunded_at) — the past payment
-- record must survive a re-keying of the reading.
--
-- But three columns hold the cached Pesapal session (`pesapal_redirect_url`,
-- `pesapal_order_id`, `payment_failed_at`) and these are AMOUNT-BOUND. When
-- the operator re-enters a different reading and `total_amount` changes, the
-- cached Pesapal session is for the OLD amount — the customer would land on
-- a checkout page that still says the old total. The cache must be
-- invalidated.
--
-- We invalidate only when `EXCLUDED.total_amount IS DISTINCT FROM
-- billing_line_items.total_amount` (true amount change) so that re-running
-- the regenerate flow with the same readings (a no-op) does not throw away
-- a working Pesapal session.
--
-- `payment_failed_at` documents that a SPECIFIC Pesapal session failed; the
-- new amount needs a fresh attempt and the old failure timestamp is no
-- longer meaningful. `payment_refunded_at` is intentionally NOT invalidated
-- — a refund is a permanent ledger entry; money moved back to the customer
-- and that fact does not get erased by a re-keyed reading.
--
-- ── Defects this fixes ────────────────────────────────────────────────────────
--
-- See #217 for the full reproduction. Aaron re-keyed Samuel Wataba's reading
-- on Sezibwa microgrid; the regenerated invoice carried the new total_amount
-- but the customer-facing PDF and the operator UI displayed the old
-- pesapal_redirect_url pointing at the old amount.
--
-- This migration ALSO unblocks the Part-B operator-recovery flow: after the
-- auto-invalidation, "Regenerate payment link" can mint a fresh URL via the
-- updated `ensurePaymentLinkForLineItem({ force: true })` path. (The route
-- and helper changes ship in the same PR but in TypeScript code, not SQL.)
--
-- ── Idempotency ───────────────────────────────────────────────────────────────
--
-- `CREATE OR REPLACE FUNCTION` with the SAME signature as 00029 — pure body
-- refactor, no codegen impact. Re-running this migration is safe.

CREATE OR REPLACE FUNCTION fn_record_line_item_with_audit(
  _billing_period_id   UUID,
  _household_id        UUID,
  _device_id           UUID,
  _usage_kwh           NUMERIC,
  _start_kwh           NUMERIC,
  _end_kwh             NUMERIC,
  _tier_breakdown      JSONB,
  _total_amount        NUMERIC,
  _reading_source      billing_line_item_reading_source,
  _entered_by_user_id  UUID,
  _manual_reason       TEXT,
  _actor_user_id       UUID,
  _audit_details       JSONB
) RETURNS billing_line_items
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row             billing_line_items%ROWTYPE;
  v_was_inserted    BOOLEAN;
  v_period_status   billing_period_status;
  v_event_type      billing_audit_event_type;
  v_entered_at      TIMESTAMPTZ;
  v_audit_details   JSONB := COALESCE(_audit_details, '{}'::jsonb);
  v_line_item_id    UUID;
BEGIN
  -- Resolve entered_at only when the new reading is manual (otherwise NULL,
  -- per AC1 of #173).
  IF _reading_source = 'manual' THEN
    v_entered_at := now();
  ELSE
    v_entered_at := NULL;
  END IF;

  -- UPSERT on (billing_period_id, household_id). On conflict, UPDATE the
  -- reading + calc + provenance columns AND invalidate the amount-bound
  -- payment-cache columns when the amount truly changes (#217).
  INSERT INTO billing_line_items (
    billing_period_id,
    household_id,
    device_id,
    usage_kwh,
    start_kwh,
    end_kwh,
    tier_breakdown,
    total_amount,
    reading_source,
    entered_by_user_id,
    entered_at,
    manual_reason
  )
  VALUES (
    _billing_period_id,
    _household_id,
    _device_id,
    _usage_kwh,
    _start_kwh,
    _end_kwh,
    COALESCE(_tier_breakdown, '[]'::jsonb),
    _total_amount,
    _reading_source,
    CASE WHEN _reading_source = 'manual' THEN _entered_by_user_id ELSE NULL END,
    v_entered_at,
    CASE WHEN _reading_source = 'manual' THEN _manual_reason ELSE NULL END
  )
  ON CONFLICT (billing_period_id, household_id) DO UPDATE SET
    device_id            = EXCLUDED.device_id,
    usage_kwh            = EXCLUDED.usage_kwh,
    start_kwh            = EXCLUDED.start_kwh,
    end_kwh              = EXCLUDED.end_kwh,
    tier_breakdown       = EXCLUDED.tier_breakdown,
    total_amount         = EXCLUDED.total_amount,
    reading_source       = EXCLUDED.reading_source,
    entered_by_user_id   = EXCLUDED.entered_by_user_id,
    entered_at           = EXCLUDED.entered_at,
    manual_reason        = EXCLUDED.manual_reason,
    -- Amount-change invalidation (#217). IS DISTINCT FROM correctly handles
    -- NULL on either side and gives us "only invalidate when the amount
    -- truly changed." total_amount is NOT NULL so this practically collapses
    -- to `<>`, but IS DISTINCT FROM is defensive against future schema
    -- relaxation.
    pesapal_redirect_url = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.pesapal_redirect_url
    END,
    pesapal_order_id     = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.pesapal_order_id
    END,
    payment_failed_at    = CASE
      WHEN EXCLUDED.total_amount IS DISTINCT FROM billing_line_items.total_amount
      THEN NULL
      ELSE billing_line_items.payment_failed_at
    END
    -- DELIBERATELY OMITTED — owned by fn_apply_payment_event and survive the
    -- UPSERT regardless of amount change:
    --   payment_status, paid_at, paid_by_user_id, payment_notes,
    --   payment_refunded_at
    --
    -- Why preserve payment_status / paid_at on amount change? If a line item
    -- was paid and then re-keyed, the past payment STILL HAPPENED. Erasing
    -- it would falsify the audit trail. The operator must reconcile manually
    -- (refund the difference, or accept the new amount as outstanding).
    --
    -- Why preserve payment_refunded_at on amount change? A refund is a
    -- permanent ledger entry — money moved back to the customer; that does
    -- not get erased by a re-keyed reading.
  RETURNING (xmax = 0), id
  INTO v_was_inserted, v_line_item_id;

  -- Re-read the row as a composite (RETURNING * + scalar isn't supported in
  -- one INTO clause). Cheap — we already hold the row lock from the UPSERT.
  SELECT * INTO v_row
  FROM billing_line_items
  WHERE id = v_line_item_id;

  -- Look up period status to derive period_was_closed (Q4=B audit hint).
  SELECT status INTO v_period_status
  FROM billing_periods
  WHERE id = _billing_period_id;

  IF v_period_status = 'closed' THEN
    v_audit_details := v_audit_details || jsonb_build_object('period_was_closed', true);
  END IF;

  v_event_type := CASE
    WHEN v_was_inserted THEN 'line_item_generated'::billing_audit_event_type
    ELSE 'line_item_regenerated'::billing_audit_event_type
  END;

  INSERT INTO billing_audit_log (
    billing_period_id,
    billing_line_item_id,
    event_type,
    actor_user_id,
    details
  )
  VALUES (
    _billing_period_id,
    v_row.id,
    v_event_type,
    _actor_user_id,
    v_audit_details
  );

  RETURN v_row;
END;
$$;

-- Defensive re-grant. CREATE OR REPLACE preserves privileges, but mirroring
-- the pattern from 00030:88-89 keeps the grant explicit at the migration
-- boundary in case the function was dropped + recreated by a future change.
GRANT EXECUTE ON FUNCTION fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB
) TO authenticated;
