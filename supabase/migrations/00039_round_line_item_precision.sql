-- 00039_round_line_item_precision.sql
-- #227: round line-item numeric inputs at write time inside
-- `fn_record_line_item_with_audit` so any caller — the rate engine
-- (`runGenerationFor`), a direct manual INSERT, a fixture seeder, a
-- future migration — gets clean precision in storage.
--
-- ── Why ───────────────────────────────────────────────────────────────────────
--
-- Peter Ntale's row on the Sezibwa microgrid persisted `usage_kwh =
-- 178.3500000000000` from JS arithmetic `261.92 - 83.570`. In real
-- arithmetic that's exactly 178.35, but IEEE-754 binary representation
-- adds 14-decimal dust. The in-app billing table's editable cell
-- (`ManualUsageCell`) surfaces the dust raw via `String(value)`.
--
-- The TypeScript helpers in `src/lib/billing/precision.ts` round at
-- the rate-engine boundary; this migration is defense-in-depth so any
-- future writer that bypasses the engine still lands clean numbers.
--
-- ── Rounding rules ────────────────────────────────────────────────────────────
--
--   _usage_kwh, _start_kwh, _end_kwh        →  3 decimals (mWh precision).
--   _total_amount                            →  integer  (UGX has no minor).
--   _tier_breakdown[].kwh                    →  3 decimals.
--   _tier_breakdown[].amount                 →  integer.
--
-- The tier-breakdown JSONB is unpacked with `WITH ORDINALITY` so the
-- tier order (T1 → T2 → T3 → T4) is preserved across the round-trip.
-- `jsonb_agg` without `ORDER BY` does NOT guarantee element order.
--
-- ── Tier-breakdown shape invariant ────────────────────────────────────────────
--
-- The unpack-repack emits exactly `{label, kwh, amount}` — the shape
-- defined by `TierBreakdown` in `src/lib/types/domain.ts` and what
-- `calculations.ts` writes. If a future ticket adds a field to
-- `TierBreakdown`, THIS FUNCTION MUST BE REVISITED or the new field is
-- silently dropped on UPSERT.
--
-- ── Preserve verbatim from 00037 (#217 link-invalidation) ─────────────────────
--
-- The CASE clauses on `pesapal_redirect_url`, `pesapal_order_id`, and
-- `payment_failed_at` compare `EXCLUDED.total_amount IS DISTINCT FROM
-- billing_line_items.total_amount`. Wrapping the parameter with ROUND()
-- in the INSERT VALUES means EXCLUDED already reflects the rounded
-- amount; the IS DISTINCT FROM semantics on integer-vs-integer remain
-- correct, and a re-run with the same readings is a no-op.
--
-- The DELIBERATELY OMITTED comment block (payment_status, paid_at,
-- paid_by_user_id, payment_notes, payment_refunded_at) is preserved
-- byte-for-byte so the next maintainer reads the same warning.
--
-- ── Idempotency ───────────────────────────────────────────────────────────────
--
-- `CREATE OR REPLACE FUNCTION` with the SAME 13-argument signature as
-- 00037 — pure body refactor, no codegen impact. Re-running is safe.
-- No backfill: existing rows keep their stored dust until the next
-- UPSERT lands a rounded value (display masked by the Part B
-- `formatForInput` cell helper).

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
  v_row                     billing_line_items%ROWTYPE;
  v_was_inserted            BOOLEAN;
  v_period_status           billing_period_status;
  v_event_type              billing_audit_event_type;
  v_entered_at              TIMESTAMPTZ;
  v_audit_details           JSONB := COALESCE(_audit_details, '{}'::jsonb);
  v_line_item_id            UUID;
  v_tier_breakdown_rounded  JSONB;
BEGIN
  -- Resolve entered_at only when the new reading is manual (otherwise NULL,
  -- per AC1 of #173).
  IF _reading_source = 'manual' THEN
    v_entered_at := now();
  ELSE
    v_entered_at := NULL;
  END IF;

  -- Round each tier-breakdown element. WITH ORDINALITY preserves the
  -- tier sequence (T1 → T2 → …) — jsonb_agg without ORDER BY does not
  -- guarantee element order. Shape MUST remain {label, kwh, amount};
  -- adding a field to TierBreakdown requires updating this function.
  v_tier_breakdown_rounded := COALESCE(
    (SELECT jsonb_agg(
       jsonb_build_object(
         'label',  elem->>'label',
         'kwh',    ROUND((elem->>'kwh')::numeric, 3),
         'amount', ROUND((elem->>'amount')::numeric, 0)
       )
       ORDER BY ord
     )
     FROM jsonb_array_elements(COALESCE(_tier_breakdown, '[]'::jsonb))
       WITH ORDINALITY AS t(elem, ord)),
    '[]'::jsonb);

  -- UPSERT on (billing_period_id, household_id). The INSERT VALUES
  -- clause applies ROUND() to each numeric column; EXCLUDED.* in the
  -- DO UPDATE SET clause inherits those rounded values, so the #217
  -- IS DISTINCT FROM CASE expressions compare rounded-vs-rounded.
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
    ROUND(_usage_kwh, 3),
    ROUND(_start_kwh, 3),
    ROUND(_end_kwh,   3),
    COALESCE(v_tier_breakdown_rounded, '[]'::jsonb),
    ROUND(_total_amount, 0),
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
-- the pattern from 00037 keeps the grant explicit at the migration
-- boundary in case the function was dropped + recreated by a future change.
GRANT EXECUTE ON FUNCTION fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB
) TO authenticated;
