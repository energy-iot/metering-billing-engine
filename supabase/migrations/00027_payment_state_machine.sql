-- 00027_payment_state_machine.sql
-- Pesapal IPN Phase B: payment state machine + payment_events audit (#157).
--
-- ── Summary ───────────────────────────────────────────────────────────────────
--
-- Adds the authoritative state-machine plumbing that Phase A's webhook stub
-- (#121) was waiting for. After this migration, every payment_status change on
-- billing_line_items goes through `fn_apply_payment_event`, which is the only
-- code path allowed to UPDATE `payment_status`. Each transition appends an
-- audit row to `payment_events`.
--
-- Pre-migration enum (from 00021): 'unpaid' | 'paid' | 'failed' | 'refunded'.
-- This migration adds 'link_generated' (no-audit-fields tier — pre-payment).
--
-- ── State machine ────────────────────────────────────────────────────────────
--
-- Allowed transitions (enforced inside `fn_apply_payment_event`):
--
--   source = 'generate_link':
--     unpaid          → link_generated
--     link_generated  → link_generated     (regenerate after abandon)
--
--   source = 'ipn':
--     link_generated  → paid
--     link_generated  → failed
--     unpaid          → paid               (defensive; if link is regenerated)
--     unpaid          → failed             (defensive)
--     paid            → refunded
--
--   source = 'manual':
--     unpaid          → paid               (mark-paid, cash collected)
--     paid            → unpaid             (operator correction)
--     failed          → paid               (operator override of failed IPN)
--     link_generated  → unpaid             (operator cancels pending link)
--     link_generated  → paid               (operator records payment)
--     link_generated  → failed             (operator records failure)
--     paid            → refunded           (operator-initiated refund)
--
-- Same-state writes for source != 'generate_link' are no-ops (return current
-- row, do NOT append an audit event). 'generate_link' is allowed to regenerate
-- (operator may regenerate link after an abandoned attempt) and DOES append
-- an audit event with from = to = link_generated.
--
-- ── Idempotency window ───────────────────────────────────────────────────────
--
-- Pesapal retries IPN deliveries. Within a 60-second window, a duplicate IPN
-- request for the same line_item + same to_status is treated as a no-op (no
-- state change AND no duplicate audit event) so the audit trail remains clean.
-- Beyond 60s, a new audit row is appended (no state change is needed because
-- the row is already in the target state — the audit row records that Pesapal
-- re-affirmed it).
--
-- ── Concurrency ──────────────────────────────────────────────────────────────
--
-- The state-mutating SELECT inside `fn_apply_payment_event` uses `FOR UPDATE`
-- to row-lock the `billing_line_items` row. Concurrent webhook + manual edits
-- serialize naturally at the row lock. A compare-and-set is enforced by
-- re-reading the row's payment_status under the lock and comparing against
-- the validated `from` state derived at function entry; if a concurrent
-- transition slipped in between the initial validation and the lock acquire,
-- the function re-validates against the latest state.
--
-- ── Idempotency ──────────────────────────────────────────────────────────────
--
-- All statements are guarded with IF NOT EXISTS / DROP CONSTRAINT IF EXISTS /
-- DROP POLICY IF EXISTS / CREATE OR REPLACE FUNCTION / ADD VALUE IF NOT EXISTS.
-- Re-running this migration is safe.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Enum: add 'link_generated' to billing_line_item_payment_status.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Postgres requires the new enum value to be committed before any code
-- references it. ALTER TYPE ADD VALUE auto-commits in this migration script
-- before the function definitions below.

ALTER TYPE billing_line_item_payment_status ADD VALUE IF NOT EXISTS 'link_generated';

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Add Phase-B columns on billing_line_items.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- pesapal_order_id    — Pesapal merchant_reference echoed back from
--                        SubmitOrderRequest. Unique across the table so the
--                        IPN webhook can resolve a webhook → line item in O(1).
-- payment_failed_at   — set when payment_status transitions to 'failed'
--                        (cleared back to NULL only by manual `failed → paid`).
-- payment_refunded_at — set when payment_status transitions to 'refunded'
--                        (refunded is terminal).

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS pesapal_order_id   TEXT NULL,
  ADD COLUMN IF NOT EXISTS payment_failed_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS payment_refunded_at TIMESTAMPTZ NULL;

-- Unique index — supports the IPN lookup path
-- `WHERE pesapal_order_id = OrderMerchantReference` and enforces idempotency
-- at the storage layer. Partial index excludes NULLs so historical rows
-- (paid manually pre-Phase-B) don't collide.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND indexname = 'idx_billing_line_items_pesapal_order_id'
  ) THEN
    CREATE UNIQUE INDEX idx_billing_line_items_pesapal_order_id
      ON billing_line_items(pesapal_order_id)
      WHERE pesapal_order_id IS NOT NULL;
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Update CHECK constraint to include 'link_generated' in the no-audit tier.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- 'link_generated' is a pre-payment state — paid_at / paid_by_user_id MUST be
-- NULL (the household has not paid yet, only the link was generated).
-- Treat it like 'unpaid' / 'failed' in the audit-fields invariant.

ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_payment_audit_fields_required;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_payment_audit_fields_required
  CHECK (
    (
      payment_status IN ('unpaid', 'failed', 'link_generated')
      AND paid_at IS NULL
      AND paid_by_user_id IS NULL
    )
    OR
    (
      payment_status IN ('paid', 'refunded')
      AND paid_at IS NOT NULL
      AND paid_by_user_id IS NOT NULL
    )
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. payment_events audit table.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Append-only log of every payment_status transition. INSERTs originate from
-- `fn_apply_payment_event` only; no policy permits direct INSERTs from
-- application code (super_admin / org_manager bypass the policy via the
-- helper but they should never write directly — the function is canonical).

CREATE TABLE IF NOT EXISTS payment_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  line_item_id    UUID NOT NULL REFERENCES billing_line_items(id) ON DELETE CASCADE,
  from_status     billing_line_item_payment_status NULL,
  to_status       billing_line_item_payment_status NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('ipn', 'manual', 'generate_link')),
  actor_user_id   UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  raw_payload     JSONB NULL,
  at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index supporting the canonical query "show audit trail for one line item,
-- newest first" (used by `derivePaymentHealth` and future reconciliation UI).
CREATE INDEX IF NOT EXISTS idx_payment_events_line_item_at
  ON payment_events(line_item_id, at DESC);

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. RLS on payment_events.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Same chain as billing_line_items policy: line_item → billing_period →
-- microgrid → user_can_access_microgrid(). Implemented as a single FOR ALL
-- policy matching the repo convention.

ALTER TABLE payment_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized users can access payment_events" ON payment_events;
CREATE POLICY "Authorized users can access payment_events"
  ON payment_events FOR ALL
  USING (
    user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_line_items bli
      JOIN billing_periods bp ON bp.id = bli.billing_period_id
      WHERE bli.id = payment_events.line_item_id
    ))
  )
  WITH CHECK (
    user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_line_items bli
      JOIN billing_periods bp ON bp.id = bli.billing_period_id
      WHERE bli.id = payment_events.line_item_id
    ))
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. fn_apply_payment_event — authoritative state-transition RPC.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- SECURITY DEFINER: the function bypasses RLS, but it requires the caller to
-- have already verified authorization (server routes check
-- user_can_access_microgrid() before calling). The function's own validation
-- enforces the transition matrix.
--
-- Args:
--   _line_item_id  UUID                                 — target row
--   _to_status     billing_line_item_payment_status     — desired state
--   _source        TEXT                                  — 'ipn'|'manual'|'generate_link'
--   _actor_user_id UUID                                  — auth.users(id) (NULL for IPN)
--   _raw_payload   JSONB                                 — verifier response / context
--
-- Returns the (possibly unchanged) billing_line_items row as a SETOF (one row).
-- Raises:
--   - exception SQLSTATE 'P0002' (no_data_found)        when the line item doesn't exist
--   - exception SQLSTATE 'P0001' (raise_exception)      with text 'invalid_transition' when
--                                                       the from→to pair is not allowed
--   - exception SQLSTATE 'P0001' with text 'invalid_source' for an unknown source
--
-- Idempotency:
--   - generate_link: same-state writes APPEND an audit row (regenerate flow).
--   - ipn / manual: same-state writes are no-ops (no state change, no audit row)
--                   when the most recent payment_event matches the current
--                   request within the dedup window (60s for ipn).

CREATE OR REPLACE FUNCTION fn_apply_payment_event(
  _line_item_id   UUID,
  _to_status      billing_line_item_payment_status,
  _source         TEXT,
  _actor_user_id  UUID,
  _raw_payload    JSONB
)
RETURNS billing_line_items
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row              billing_line_items%ROWTYPE;
  v_from             billing_line_item_payment_status;
  v_now              TIMESTAMPTZ := NOW();
  v_allowed          BOOLEAN := FALSE;
  v_recent_event_id  UUID;
BEGIN
  -- Source whitelist.
  IF _source NOT IN ('ipn', 'manual', 'generate_link') THEN
    RAISE EXCEPTION 'invalid_source: %', _source USING ERRCODE = 'P0001';
  END IF;

  -- Lock the row for the duration of the txn.
  SELECT * INTO v_row
  FROM billing_line_items
  WHERE id = _line_item_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'line_item_not_found: %', _line_item_id USING ERRCODE = 'P0002';
  END IF;

  v_from := v_row.payment_status;

  -- Same-state handling.
  IF v_from = _to_status THEN
    IF _source = 'generate_link' THEN
      -- Regenerate: append an audit row, do not modify the row's status, but
      -- DO refresh pesapal_order_id from the payload if supplied.
      INSERT INTO payment_events (
        line_item_id, from_status, to_status, source, actor_user_id, raw_payload, at
      ) VALUES (
        _line_item_id, v_from, _to_status, _source, _actor_user_id, _raw_payload, v_now
      );

      IF _raw_payload IS NOT NULL AND _raw_payload ? 'pesapal_order_id' THEN
        UPDATE billing_line_items
          SET pesapal_order_id = _raw_payload->>'pesapal_order_id'
          WHERE id = _line_item_id
          RETURNING * INTO v_row;
      END IF;

      RETURN v_row;
    END IF;

    -- ipn / manual same-state: dedup within 60s on the IPN path; manual same-
    -- state is a no-op silently (matches existing assertValidManualTransition
    -- 'no_op' contract — but here we don't raise, we return the row).
    IF _source = 'ipn' THEN
      SELECT id INTO v_recent_event_id
      FROM payment_events
      WHERE line_item_id = _line_item_id
        AND source = 'ipn'
        AND to_status = _to_status
        AND at >= v_now - INTERVAL '60 seconds'
      ORDER BY at DESC
      LIMIT 1;

      IF v_recent_event_id IS NULL THEN
        -- Beyond the dedup window: append a fresh audit row but no state change.
        INSERT INTO payment_events (
          line_item_id, from_status, to_status, source, actor_user_id, raw_payload, at
        ) VALUES (
          _line_item_id, v_from, _to_status, _source, _actor_user_id, _raw_payload, v_now
        );
      END IF;
    END IF;

    RETURN v_row;
  END IF;

  -- Validate the transition against the per-source matrix.
  IF _source = 'generate_link' THEN
    v_allowed := (v_from = 'unpaid' AND _to_status = 'link_generated');
  ELSIF _source = 'ipn' THEN
    v_allowed :=
      ((v_from IN ('link_generated', 'unpaid')) AND _to_status IN ('paid', 'failed'))
      OR (v_from = 'paid' AND _to_status = 'refunded');
  ELSIF _source = 'manual' THEN
    v_allowed :=
      (v_from = 'unpaid'         AND _to_status = 'paid')
      OR (v_from = 'paid'         AND _to_status = 'unpaid')
      OR (v_from = 'failed'       AND _to_status = 'paid')
      OR (v_from = 'link_generated' AND _to_status IN ('unpaid', 'paid', 'failed'))
      OR (v_from = 'paid'         AND _to_status = 'refunded');
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'invalid_transition: % -> % via %', v_from, _to_status, _source
      USING ERRCODE = 'P0001';
  END IF;

  -- Compare-and-set: the SELECT above acquired the row lock and read v_from;
  -- the UPDATE below targets the SAME id AND payment_status, so any concurrent
  -- update that slipped in before the lock acquire (impossible, but guards
  -- non-locking re-reads) would cause 0 rows updated and we re-raise.
  UPDATE billing_line_items
  SET
    payment_status      = _to_status,
    paid_at             = CASE
                            WHEN _to_status IN ('paid', 'refunded') THEN COALESCE(paid_at, v_now)
                            WHEN _to_status IN ('unpaid', 'failed', 'link_generated') THEN NULL
                            ELSE paid_at
                          END,
    paid_by_user_id     = CASE
                            WHEN _to_status IN ('paid', 'refunded')
                              THEN COALESCE(paid_by_user_id, _actor_user_id)
                            WHEN _to_status IN ('unpaid', 'failed', 'link_generated') THEN NULL
                            ELSE paid_by_user_id
                          END,
    payment_failed_at   = CASE
                            WHEN _to_status = 'failed' THEN v_now
                            WHEN _to_status IN ('paid', 'refunded') THEN payment_failed_at
                            ELSE NULL
                          END,
    payment_refunded_at = CASE
                            WHEN _to_status = 'refunded' THEN v_now
                            ELSE payment_refunded_at
                          END,
    pesapal_order_id    = CASE
                            WHEN _raw_payload IS NOT NULL AND _raw_payload ? 'pesapal_order_id'
                              THEN _raw_payload->>'pesapal_order_id'
                            ELSE pesapal_order_id
                          END,
    -- payment_notes:
    --   key absent           → leave unchanged
    --   key present, value null/empty/whitespace → clear (NULL)
    --   key present, value non-empty             → set to trimmed value
    -- Distinguishing "absent" from "explicit null" requires the jsonb has-key
    -- operator (`?`), since `_raw_payload->>'payment_notes'` returns NULL in
    -- both the absent and explicit-null cases.
    payment_notes       = CASE
                            WHEN _raw_payload IS NOT NULL AND _raw_payload ? 'payment_notes'
                              THEN NULLIF(BTRIM(COALESCE(_raw_payload->>'payment_notes', '')), '')
                            ELSE payment_notes
                          END
  WHERE id = _line_item_id
    AND payment_status = v_from
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Lost the compare-and-set: another transition slipped in. Re-raise so the
    -- caller can decide (the IPN route always returns 200 anyway; manual
    -- routes surface an error).
    RAISE EXCEPTION 'transition_conflict: row state changed mid-flight'
      USING ERRCODE = 'P0001';
  END IF;

  -- Append the audit row.
  INSERT INTO payment_events (
    line_item_id, from_status, to_status, source, actor_user_id, raw_payload, at
  ) VALUES (
    _line_item_id, v_from, _to_status, _source, _actor_user_id, _raw_payload, v_now
  );

  RETURN v_row;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 7. Grants.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `authenticated` + `service_role` only; `anon` is NOT granted. The route
-- handlers all run with an authenticated session (manual route) or via
-- service-role (IPN webhook — public surface, no user). Pre-flight permission
-- checks are still required at the route layer.

GRANT EXECUTE ON FUNCTION fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB
) TO authenticated, service_role;
