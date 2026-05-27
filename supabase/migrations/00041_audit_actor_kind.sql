-- 00041_audit_actor_kind.sql
-- #250 — fix the billing_audit_log FK violation introduced by PR #246's
-- CUSTOMERAPP_ACTOR_ID constant by adding `actor_kind` + `actor_ref`
-- columns to both `billing_audit_log` and `payment_events`, symmetrically.
--
-- ── Why ───────────────────────────────────────────────────────────────────
--
-- PR #246 attributed customerapp-originated audit entries to a fixed UUID
-- (`00000000-0000-4000-8000-000000000001`) that is NOT seeded in
-- `auth.users`. The first real call to `POST /api/internal/billing/generate`
-- would therefore trip the FK on `billing_audit_log.actor_user_id` and
-- 500. The integration cannot serve any traffic until this is fixed.
--
-- Per #250 PM scope ("Path A") + Architect appendix (2026-05-26):
--   * `actor_user_id` becomes nullable on both tables (was already nullable
--     by intent on `billing_audit_log` per 00029 line 122 and on
--     `payment_events` per 00028 line 154 — the explicit DROP NOT NULL here
--     is idempotent / belt-and-suspenders).
--   * New `actor_kind TEXT NOT NULL DEFAULT 'human'` with a domain CHECK
--     (`'human' | 'customerapp' | 'system'`).
--   * New `actor_ref TEXT NULL` — opaque caller-supplied identifier
--     (token name for customerapp, source key like `'pesapal_ipn'` for
--     system).
--   * One composite CHECK enforcing the shape: human rows must carry
--     `actor_user_id` and NOT carry `actor_ref`; non-human rows must NOT
--     carry `actor_user_id` and MUST carry `actor_ref`. This is the
--     belt-and-suspenders implementation of the PM AC "audit row with
--     `actor_kind='human'` AND `actor_user_id=NULL` is rejected".
--
-- ── Function widening (PostgREST overload trap — PR #209 lesson) ──────────
--
-- `fn_record_line_item_with_audit` (canonical: 00029, re-defined 00037 +
-- 00039) and `fn_apply_payment_event` (00028) both grow `_actor_kind TEXT`
-- and `_actor_ref TEXT` parameters. PostgREST overload resolution rejects
-- additive optional-param changes with `PGRST203 — Could not choose the
-- best candidate function` because the OLD signature lingers as a sibling
-- overload. The fix (per PR #209) is mandatory DROP FUNCTION IF EXISTS
-- BEFORE CREATE OR REPLACE — do NOT collapse this to `CREATE OR REPLACE`
-- alone even though it feels like overkill. See the SIGNATURE NOTE comment
-- at each TS call site for the next-refactorer breadcrumb.
--
-- ── Audit-event enum widening (consolidated per Phase 3) ──────────────────
--
-- `billing_audit_event_type` gains FOUR new values in a single widening
-- (per the appendix — consolidates here so #256 doesn't have to touch the
-- enum again):
--   * `billing_period_created`  — consumed by `/api/internal/billing-periods`
--                                  POST (this migration's caller-update step
--                                  adds the audit-write).
--   * `token_generated`         — consumed by #256 UI (Wave C/D).
--   * `token_revoked`           — consumed by #256 UI (Wave C/D).
--   * `token_regenerated`       — consumed by #256 UI (Wave C/D).
--
-- ── ALTER TYPE … ADD VALUE rule (2026-04 lesson, re-applied) ──────────────
--
-- Postgres rejects "unsafe use of new enum value" inside the SAME transaction
-- that added it. The defensive split for THIS migration:
--   * 00041 (here): ADD VALUE for all 4 new event_type values.
--   * 00041 (here): NOTHING in this file references the new values
--     (no INSERTs, no CASTs, no string-literal `::billing_audit_event_type`).
--   * Consumers (`billing_period_created` etc.) live in the TS route code
--     that this PR also updates — Postgres only enforces the same-txn rule
--     against SQL inside the migration, so the TS callers running in a
--     subsequent connection are fine.
--
-- This is also why the `ALTER TYPE … ADD VALUE` statements sit at the END
-- of the file, AFTER the function DROP+CREATE pair — the function bodies
-- never reference the new enum values, only the columns / param-shape.
--
-- ── Idempotency ───────────────────────────────────────────────────────────
--
-- Every ADD / DROP / ALTER is guarded with IF NOT EXISTS / IF EXISTS where
-- the syntax permits. The CHECK constraints are DROP-then-ADD. Re-running
-- this migration is safe.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. billing_audit_log — add actor_kind / actor_ref, relax actor_user_id.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `actor_user_id` is already declared NULL in 00029 (the DROP NOT NULL is a
-- no-op there; included so the migration is self-contained on a fresh DB
-- where someone might have tightened it).

ALTER TABLE billing_audit_log
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE billing_audit_log
  ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_kind IN ('human', 'customerapp', 'system'));

ALTER TABLE billing_audit_log
  ADD COLUMN IF NOT EXISTS actor_ref TEXT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. payment_events — same three changes, mirrored.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Backfill caveat: pre-migration payment_events rows written by the Pesapal
-- IPN webhook carry `actor_user_id IS NULL` (per 00028 + 00040 — IPN has no
-- human actor). Once we add `actor_kind DEFAULT 'human'`, those legacy rows
-- would fail the composite CHECK ("human rows must have actor_user_id").
-- Backfill them to `('system', 'pesapal_ipn_legacy')` BEFORE the CHECK is
-- added so the constraint can be created without a workaround.

ALTER TABLE payment_events
  ALTER COLUMN actor_user_id DROP NOT NULL;

ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS actor_kind TEXT NOT NULL DEFAULT 'human'
    CHECK (actor_kind IN ('human', 'customerapp', 'system'));

ALTER TABLE payment_events
  ADD COLUMN IF NOT EXISTS actor_ref TEXT NULL;

-- Backfill legacy IPN rows (NULL actor_user_id pre-#250) so they satisfy
-- the composite CHECK we're about to add. Manual / generate_link rows
-- carry actor_user_id and stay as actor_kind='human'.
UPDATE payment_events
SET    actor_kind = 'system',
       actor_ref  = COALESCE(actor_ref, 'pesapal_ipn_legacy')
WHERE  actor_user_id IS NULL
  AND  actor_kind    = 'human';

-- Defensive mirror for billing_audit_log — no production rows should be in
-- this shape per 00029's writer contract ("This ticket's writers always
-- pass auth.uid() (never NULL)"), but if a future migration ever lands a
-- system-actor row pre-#250 the backfill here keeps the CHECK satisfiable.
UPDATE billing_audit_log
SET    actor_kind = 'system',
       actor_ref  = COALESCE(actor_ref, 'legacy_system_actor')
WHERE  actor_user_id IS NULL
  AND  actor_kind    = 'human';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Composite CHECK constraints — actor shape invariant.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Per PM AC ("audit row with `actor_kind='human'` AND `actor_user_id=NULL`
-- is rejected") and Architect appendix:
--
--   human       → actor_user_id NOT NULL, actor_ref NULL
--   non-human   → actor_user_id NULL,     actor_ref NOT NULL
--
-- DROP-then-ADD so re-running the migration is safe; CHECKs cannot be
-- altered in place.

ALTER TABLE billing_audit_log
  DROP CONSTRAINT IF EXISTS billing_audit_log_actor_consistency;
ALTER TABLE billing_audit_log
  ADD CONSTRAINT billing_audit_log_actor_consistency CHECK (
    (actor_kind = 'human'  AND actor_user_id IS NOT NULL AND actor_ref IS NULL)
    OR
    (actor_kind <> 'human' AND actor_user_id IS NULL     AND actor_ref IS NOT NULL)
  );

ALTER TABLE payment_events
  DROP CONSTRAINT IF EXISTS payment_events_actor_consistency;
ALTER TABLE payment_events
  ADD CONSTRAINT payment_events_actor_consistency CHECK (
    (actor_kind = 'human'  AND actor_user_id IS NOT NULL AND actor_ref IS NULL)
    OR
    (actor_kind <> 'human' AND actor_user_id IS NULL     AND actor_ref IS NOT NULL)
  );

COMMENT ON CONSTRAINT billing_audit_log_actor_consistency ON billing_audit_log IS
  'Actor shape invariant (#250): human rows carry actor_user_id and not actor_ref; non-human (customerapp/system) rows carry actor_ref and not actor_user_id.';

COMMENT ON CONSTRAINT payment_events_actor_consistency ON payment_events IS
  'Actor shape invariant (#250) — mirror of billing_audit_log_actor_consistency.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. fn_record_line_item_with_audit — widen signature.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- PR #209 lesson, re-applied: DROP FUNCTION IF EXISTS before CREATE OR
-- REPLACE because adding optional params creates a sibling overload that
-- PostgREST rejects with PGRST203. The DROP+CREATE is mandatory; do NOT
-- collapse to CREATE OR REPLACE alone.
--
-- New params: `_actor_kind TEXT`, `_actor_ref TEXT` — passed straight
-- through to the `billing_audit_log` INSERT. Function body is otherwise a
-- carbon-copy of 00039's version (the canonical "rounded + invalidate
-- payment link on amount change" body).

DROP FUNCTION IF EXISTS fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB
);

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
  _audit_details       JSONB,
  _actor_kind          TEXT DEFAULT 'human',
  _actor_ref           TEXT DEFAULT NULL
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
  -- tier sequence (T1 → T2 → …); jsonb_agg without ORDER BY does not
  -- guarantee element order. Shape MUST remain {label, kwh, amount}.
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

  -- UPSERT on (billing_period_id, household_id) — body unchanged from 00039.
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
    -- DELIBERATELY OMITTED — owned by fn_apply_payment_event:
    --   payment_status, paid_at, paid_by_user_id, payment_notes,
    --   payment_refunded_at
  RETURNING (xmax = 0), id
  INTO v_was_inserted, v_line_item_id;

  -- Re-read as a composite.
  SELECT * INTO v_row
  FROM billing_line_items
  WHERE id = v_line_item_id;

  -- Period-was-closed audit hint (Q4=B).
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
    actor_kind,
    actor_ref,
    details
  )
  VALUES (
    _billing_period_id,
    v_row.id,
    v_event_type,
    _actor_user_id,
    COALESCE(_actor_kind, 'human'),
    _actor_ref,
    v_audit_details
  );

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_record_line_item_with_audit(
  UUID, UUID, UUID, NUMERIC, NUMERIC, NUMERIC, JSONB, NUMERIC,
  billing_line_item_reading_source, UUID, TEXT, UUID, JSONB, TEXT, TEXT
) TO authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 5. fn_apply_payment_event — widen signature.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Same DROP+CREATE pattern; body unchanged from 00028 except the
-- payment_events INSERTs now also write actor_kind / actor_ref.

DROP FUNCTION IF EXISTS fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB
);

CREATE OR REPLACE FUNCTION fn_apply_payment_event(
  _line_item_id   UUID,
  _to_status      billing_line_item_payment_status,
  _source         TEXT,
  _actor_user_id  UUID,
  _raw_payload    JSONB,
  _actor_kind     TEXT DEFAULT 'human',
  _actor_ref      TEXT DEFAULT NULL
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
  v_actor_kind       TEXT := COALESCE(_actor_kind, 'human');
BEGIN
  -- Source whitelist.
  IF _source NOT IN ('ipn', 'manual', 'generate_link') THEN
    RAISE EXCEPTION 'invalid_source: %', _source USING ERRCODE = 'P0001';
  END IF;

  -- Lock the row.
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
      -- Regenerate path: append audit row, no state change; optional
      -- pesapal_order_id refresh.
      INSERT INTO payment_events (
        line_item_id, from_status, to_status, source,
        actor_user_id, actor_kind, actor_ref, raw_payload, at
      ) VALUES (
        _line_item_id, v_from, _to_status, _source,
        _actor_user_id, v_actor_kind, _actor_ref, _raw_payload, v_now
      );

      IF _raw_payload IS NOT NULL AND _raw_payload ? 'pesapal_order_id' THEN
        UPDATE billing_line_items
          SET pesapal_order_id = _raw_payload->>'pesapal_order_id'
          WHERE id = _line_item_id
          RETURNING * INTO v_row;
      END IF;

      RETURN v_row;
    END IF;

    -- ipn / manual same-state: dedup IPN within 60s; manual same-state is
    -- a no-op silently.
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
        INSERT INTO payment_events (
          line_item_id, from_status, to_status, source,
          actor_user_id, actor_kind, actor_ref, raw_payload, at
        ) VALUES (
          _line_item_id, v_from, _to_status, _source,
          _actor_user_id, v_actor_kind, _actor_ref, _raw_payload, v_now
        );
      END IF;
    END IF;

    RETURN v_row;
  END IF;

  -- Validate the transition against the per-source matrix (unchanged).
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

  -- Compare-and-set on the row.
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
    payment_notes       = CASE
                            WHEN _raw_payload IS NOT NULL AND _raw_payload ? 'payment_notes'
                              THEN NULLIF(BTRIM(COALESCE(_raw_payload->>'payment_notes', '')), '')
                            ELSE payment_notes
                          END
  WHERE id = _line_item_id
    AND payment_status = v_from
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_conflict: row state changed mid-flight'
      USING ERRCODE = 'P0001';
  END IF;

  -- Append the audit row.
  INSERT INTO payment_events (
    line_item_id, from_status, to_status, source,
    actor_user_id, actor_kind, actor_ref, raw_payload, at
  ) VALUES (
    _line_item_id, v_from, _to_status, _source,
    _actor_user_id, v_actor_kind, _actor_ref, _raw_payload, v_now
  );

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB, TEXT, TEXT
) TO authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- 6. ALTER TYPE … ADD VALUE for the 4 new audit event types.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- MUST sit AFTER everything else in the file because Postgres rejects
-- "unsafe use of new enum value" inside the same transaction that added it.
-- Nothing else in 00041 references these values; they are consumed by TS
-- route code that runs in a subsequent connection.
--
-- IF NOT EXISTS keeps the migration idempotent (Postgres 12+).

ALTER TYPE billing_audit_event_type ADD VALUE IF NOT EXISTS 'billing_period_created';
ALTER TYPE billing_audit_event_type ADD VALUE IF NOT EXISTS 'token_generated';
ALTER TYPE billing_audit_event_type ADD VALUE IF NOT EXISTS 'token_revoked';
ALTER TYPE billing_audit_event_type ADD VALUE IF NOT EXISTS 'token_regenerated';
