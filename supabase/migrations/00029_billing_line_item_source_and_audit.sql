-- 00029_billing_line_item_source_and_audit.sql
-- BC1 (#173): selective generation, manual readings, audit log.
--
-- ── Summary ───────────────────────────────────────────────────────────────────
--
-- Adds the schema + RPC plumbing that BC2/BC3/BC4 need:
--
--   1. New enum `billing_line_item_reading_source` ('edge' | 'manual') and
--      four new columns on `billing_line_items` (reading_source,
--      entered_by_user_id, entered_at, manual_reason). Existing rows are
--      backfilled implicitly via the column DEFAULT.
--   2. New UNIQUE index on `billing_line_items(billing_period_id, household_id)`
--      — required for the `INSERT … ON CONFLICT (billing_period_id, household_id)
--      DO UPDATE …` path used by `fn_record_line_item_with_audit`.
--   3. New enum `billing_audit_event_type` and append-only `billing_audit_log`
--      table with split SELECT/INSERT RLS policies (FOR ALL would silently
--      grant UPDATE/DELETE; this table is append-only). Default-deny on
--      UPDATE/DELETE is the intended escape-hatch for a database operator.
--   4. New SECURITY INVOKER RPC `fn_record_line_item_with_audit` that performs
--      the line-item upsert and the audit-row insert in one transaction. It
--      preserves payment fields on UPSERT-UPDATE (CRITICAL — the existing
--      delete-then-insert flow loses payment_status / paid_at / paid_by_user_id
--      and cascades the entire payment_events history away).
--
-- ── Out-of-scope (do NOT add here) ────────────────────────────────────────────
--
-- - `payment_status_changed` / `payment_link_generated` audit entries — they
--   live exclusively in `payment_events` (00028) and are UNIONed at read time.
-- - `period_reopened` event type — Q4=B keeps periods closed even on
--   regenerate, so the value is meaningless.
-- - `reading_source_changed` standalone event — folded into the
--   `line_item_regenerated.details.{previous,new}_reading_source` keys.
-- - Modifying `fn_apply_payment_event` or `payment_events`.
--
-- ── Idempotency ───────────────────────────────────────────────────────────────
--
-- Every CREATE / ADD / GRANT is guarded with IF NOT EXISTS / DROP-then-CREATE
-- so re-running the migration is safe.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Reading-source enum + new columns on billing_line_items.
-- ═════════════════════════════════════════════════════════════════════════════

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_line_item_reading_source') THEN
    CREATE TYPE billing_line_item_reading_source AS ENUM ('edge', 'manual');
  END IF;
END;
$$;

ALTER TABLE billing_line_items
  ADD COLUMN IF NOT EXISTS reading_source billing_line_item_reading_source NOT NULL DEFAULT 'edge',
  ADD COLUMN IF NOT EXISTS entered_by_user_id UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS entered_at TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS manual_reason TEXT NULL;

ALTER TABLE billing_line_items DROP CONSTRAINT IF EXISTS billing_line_items_manual_reason_max_length;
ALTER TABLE billing_line_items
  ADD CONSTRAINT billing_line_items_manual_reason_max_length
  CHECK (manual_reason IS NULL OR length(manual_reason) <= 500);

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. UNIQUE index on (billing_period_id, household_id).
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Required for `INSERT … ON CONFLICT (billing_period_id, household_id) DO UPDATE`
-- in `fn_record_line_item_with_audit`. Both columns are NOT NULL on the table
-- (00001:239-240) so a full UNIQUE (no partial predicate) is correct — every
-- line item belongs to exactly one (period, household) pair.

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_line_items_period_household
  ON billing_line_items (billing_period_id, household_id);

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Audit event-type enum.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Values:
--   period_created          — a billing period was created (writer TBD; this
--                             ticket does not write it; included so future
--                             writers + the audit endpoint can use it).
--   period_closed           — a billing period was closed (writer TBD).
--   line_item_generated     — a line item was newly inserted (xmax = 0).
--   line_item_regenerated   — a line item was UPDATEed via UPSERT-CONFLICT.
--
-- Do NOT add `payment_status_changed` / `payment_link_generated` /
-- `reading_source_changed` / `period_reopened` here — see header comment.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'billing_audit_event_type') THEN
    CREATE TYPE billing_audit_event_type AS ENUM (
      'period_created',
      'period_closed',
      'line_item_generated',
      'line_item_regenerated'
    );
  END IF;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. billing_audit_log — append-only audit table.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- billing_line_item_id is ON DELETE SET NULL (NOT CASCADE) so the audit row
-- survives a hard delete of the underlying line item. The household_name
-- snapshot in `details` keeps the row renderable even after the FK resolves
-- to NULL.
--
-- actor_user_id is NULLABLE — matches `payment_events.actor_user_id`
-- (00028:154). This ticket's writers always pass `auth.uid()` (never NULL);
-- the column is left nullable to admit future system-actor cases (cron close,
-- IPN-triggered regenerate, etc.) without an ALTER.

CREATE TABLE IF NOT EXISTS billing_audit_log (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_period_id    UUID NOT NULL REFERENCES billing_periods(id) ON DELETE CASCADE,
  billing_line_item_id UUID NULL REFERENCES billing_line_items(id) ON DELETE SET NULL,
  event_type           billing_audit_event_type NOT NULL,
  actor_user_id        UUID NULL REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  details              JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_billing_audit_log_period_created_at
  ON billing_audit_log (billing_period_id, created_at DESC);

-- ── RLS — split SELECT / INSERT (append-only) ────────────────────────────────

ALTER TABLE billing_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Authorized users can read billing_audit_log" ON billing_audit_log;
CREATE POLICY "Authorized users can read billing_audit_log"
  ON billing_audit_log FOR SELECT
  USING (
    user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_periods bp
      WHERE bp.id = billing_audit_log.billing_period_id
    ))
  );

DROP POLICY IF EXISTS "Authorized users can write billing_audit_log" ON billing_audit_log;
CREATE POLICY "Authorized users can write billing_audit_log"
  ON billing_audit_log FOR INSERT
  WITH CHECK (
    user_can_access_microgrid((
      SELECT bp.microgrid_id
      FROM billing_periods bp
      WHERE bp.id = billing_audit_log.billing_period_id
    ))
  );

-- No UPDATE policy. No DELETE policy. Default-deny is intentional —
-- append-only invariant is preserved against every authenticated client,
-- super_admin included. A database operator with direct SQL access is the
-- only escape hatch.

GRANT SELECT, INSERT ON billing_audit_log TO authenticated;
-- Belt-and-suspenders: explicitly NOT granting UPDATE / DELETE.

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. fn_record_line_item_with_audit — atomic line-item + audit-row writer.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Performs:
--   (a) UPSERT-by-(billing_period_id, household_id) on billing_line_items.
--       UPDATE preserves payment_status, paid_at, paid_by_user_id, payment_notes,
--       pesapal_order_id, payment_failed_at, payment_refunded_at — these are
--       owned by `fn_apply_payment_event` (00028) and the regenerate flow
--       must never overwrite them. The CHECK constraint
--       `billing_line_items_payment_audit_fields_required` (00021/00028) would
--       otherwise reject a regenerate against a paid row.
--   (b) An INSERT into billing_audit_log with the supplied `_audit_details`
--       plus the derived `period_was_closed` flag.
--
-- INSERT-vs-UPDATE detection uses the `xmax = 0` MVCC trick — true only when
-- the row is freshly inserted (no prior live tuple). A CONFLICT-triggered
-- UPDATE leaves xmax non-zero. Reliable on Postgres 14+/Supabase 15.x.
--
-- SECURITY INVOKER (NOT DEFINER) — the audit-log INSERT WITH CHECK policy
-- must fire under the caller's identity so the chain is enforced even when
-- the route handler's pre-flight permission check passed. DEFINER would
-- bypass the policy and break the "writes happen as the actor" invariant.
--
-- Concurrency note: `fn_apply_payment_event` (00028:249) acquires FOR UPDATE
-- on the line item. The UPSERT here also implicitly row-locks. Postgres
-- serializes them; first writer wins. The UPDATE clause here explicitly
-- omits payment_status/paid_at/paid_by_user_id/pesapal_order_id from the SET
-- list, so even if an IPN slips between the route's read and this RPC's
-- write, no payment column is overwritten. DO NOT add payment columns to the
-- UPDATE SET below — see header comment.

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
  -- per AC1).
  IF _reading_source = 'manual' THEN
    v_entered_at := now();
  ELSE
    v_entered_at := NULL;
  END IF;

  -- UPSERT on (billing_period_id, household_id). On conflict, UPDATE only the
  -- reading + calc + provenance columns; PRESERVE payment fields explicitly.
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
    device_id          = EXCLUDED.device_id,
    usage_kwh          = EXCLUDED.usage_kwh,
    start_kwh          = EXCLUDED.start_kwh,
    end_kwh            = EXCLUDED.end_kwh,
    tier_breakdown     = EXCLUDED.tier_breakdown,
    total_amount       = EXCLUDED.total_amount,
    reading_source     = EXCLUDED.reading_source,
    entered_by_user_id = EXCLUDED.entered_by_user_id,
    entered_at         = EXCLUDED.entered_at,
    manual_reason      = EXCLUDED.manual_reason
    -- DELIBERATELY OMITTED — owned by fn_apply_payment_event:
    --   payment_status, paid_at, paid_by_user_id, payment_notes,
    --   pesapal_order_id, payment_failed_at, payment_refunded_at
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

GRANT EXECUTE ON FUNCTION fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB
) TO authenticated;
