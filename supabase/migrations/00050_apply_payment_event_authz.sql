-- 00050_apply_payment_event_authz.sql
--
-- Adds a body-side authorization gate to `fn_apply_payment_event` and derives
-- the audit actor server-side.
--
-- ── Background ─────────────────────────────────────────────────────────────
--
-- `fn_apply_payment_event` (7-arg signature introduced in 00041) is
-- SECURITY DEFINER and granted EXECUTE to `authenticated, service_role`
-- (00045). Its body performed no authorization check of its own, so the
-- function relied entirely on its grant rather than on its body. Every
-- SECURITY DEFINER function granted to `authenticated` should carry a
-- body-side gate; this one did not.
--
-- Separately, the audit actor triple (`_actor_user_id`, `_actor_kind`,
-- `_actor_ref`) was caller-supplied and written verbatim to `payment_events`,
-- so the audit trail was caller-controlled.
--
-- ── Change 1: deny-by-default authorization gate ──────────────────────────
--
-- Same shape as `fn_get_ems_secret` (00032): a gate with one explicitly
-- named exception.
--
--   IF NOT (auth.role() = 'service_role' OR <caller may access the org>)
--
-- `service_role` is named explicitly rather than inferred from a NULL
-- `auth.uid()`. Inferring it would let every caller without a session
-- through — which is `anon` as well as `service_role` — leaving the function
-- protected by its grant instead of its body, i.e. the original defect one
-- layer down. Naming the bypass means `anon` is refused by the body no
-- matter what a future migration does to the grant.
--
-- Org resolution reuses the same chain the `billing_line_items` RLS policy
-- uses (00002_rls.sql:176): line item → billing_periods.microgrid_id →
-- `user_can_access_microgrid()`, which resolves microgrid → community → org
-- and short-circuits true for super_admin.
--
-- The gate raises `42501` (insufficient_privilege) rather than returning
-- NULL: the function RETURNS billing_line_items, where NULL is
-- indistinguishable from a legitimate "no row" and would be silently
-- swallowed by callers.
--
-- The three user-scoped call sites all perform the equivalent app-level check
-- (`currentUserCanAccessMicrogrid`) before the RPC, so the gate duplicates an
-- existing decision rather than inventing policy. EXECUTE is deliberately NOT
-- revoked from `authenticated` — three of five call sites run under the
-- cookie-bound client, and migrating them to service-role would contradict
-- the policy stated in `src/lib/supabase/service.ts` ("Application code NEVER
-- uses the service-role client for tenant data reads/writes"). The grant
-- stays; the body now does the work.
--
-- ── Change 2: server-derived audit actor ──────────────────────────────────
--
-- All three actor parameters are overridden (not validated) for callers with
-- a session, keyed on the SAME discriminator as the gate:
--
--   service_role → caller-supplied triple survives (IPN webhook and the
--                  public /pay redirect are genuinely external actors with
--                  no session to derive a uid from)
--   otherwise    → (auth.uid(), 'human', NULL)
--
-- Keying on `auth.role() = 'service_role'` rather than `auth.uid() IS NOT
-- NULL` means both decisions in this function derive from one discriminator
-- rather than two that happen to agree today.
--
-- Never key on `_actor_kind`: it is caller-supplied and defaults to 'human'
-- (00041), so any rule of the form "if _actor_kind = 'human' then check the
-- actor" is bypassed by passing 'system'.
--
-- All three must be pinned together, not just the user id. 00041 added
-- `payment_events_actor_consistency`:
--
--     (actor_kind =  'human' AND actor_user_id IS NOT NULL AND actor_ref IS NULL)
--  OR (actor_kind <> 'human' AND actor_user_id IS NULL     AND actor_ref IS NOT NULL)
--
-- Forcing only `actor_user_id` while leaving `_actor_kind` as passed lets a
-- session caller sending `_actor_kind='system'` produce `actor_kind <>
-- 'human'` alongside a non-NULL `actor_user_id`, which the constraint
-- rejects at runtime. Pinning all three satisfies the constraint by
-- construction and closes both halves of the spoofing hole.
--
-- Override rather than validate: raising on mismatch would add a failure path
-- to routes that work today. Assignment adds none and is a no-op for every
-- current caller — the three session-bound routes already pass
-- (`user.id`, 'human', NULL). Afterwards the three parameters carry no
-- meaning for session callers, so a future route cannot get them wrong.
--
-- The two changes land together deliberately. The override is only safe
-- underneath a deny-by-default gate: under an allow-by-default gate the ELSE
-- branch (caller-supplied triple) would be reachable by `anon`.
--
-- ── Signature & grants ────────────────────────────────────────────────────
--
-- Signature is UNCHANGED, so no DROP is required and PostgREST overload
-- resolution is unaffected. `CREATE OR REPLACE` preserves privileges in
-- Postgres >= 14; the GRANT is re-issued defensively to mirror
-- 00032 / 00041 / 00045 and keep the grant explicit at the migration
-- boundary.
--
-- Everything below the gate/actor block is byte-identical to 00041.

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
  v_microgrid_id     UUID;
  v_is_service_role  BOOLEAN := (auth.role() = 'service_role');
  v_actor_user_id    UUID;
  v_actor_kind       TEXT;
  v_actor_ref        TEXT;
BEGIN
  -- ── Authorization gate (deny-by-default, one named exception) ──────────
  --
  -- Resolve the owning microgrid via the line item's billing period. A
  -- missing line item yields a NULL microgrid id, so a non-service_role
  -- caller is refused here rather than learning from the error code whether
  -- the id exists.
  SELECT bp.microgrid_id INTO v_microgrid_id
  FROM billing_line_items bli
  JOIN billing_periods bp ON bp.id = bli.billing_period_id
  WHERE bli.id = _line_item_id;

  IF NOT (
    v_is_service_role
    OR (v_microgrid_id IS NOT NULL AND user_can_access_microgrid(v_microgrid_id))
  ) THEN
    RAISE EXCEPTION 'permission denied for line item %', _line_item_id
      USING ERRCODE = '42501';
  END IF;

  -- ── Audit actor — derived server-side, same discriminator as the gate ──
  IF v_is_service_role THEN
    -- IPN webhook / public /pay redirect: external actor, no session.
    v_actor_user_id := _actor_user_id;
    v_actor_kind    := COALESCE(_actor_kind, 'human');
    v_actor_ref     := _actor_ref;
  ELSE
    -- Session caller: whatever was passed is ignored entirely.
    v_actor_user_id := auth.uid();
    v_actor_kind    := 'human';
    v_actor_ref     := NULL;
  END IF;

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
        v_actor_user_id, v_actor_kind, v_actor_ref, _raw_payload, v_now
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
          v_actor_user_id, v_actor_kind, v_actor_ref, _raw_payload, v_now
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
  --
  -- paid_by_user_id now takes the DERIVED actor id rather than the raw
  -- parameter, for the same reason payment_events does. No behaviour change
  -- for current callers: session routes already pass exactly auth.uid(), and
  -- the service-role paths pass their value through untouched.
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
                              THEN COALESCE(paid_by_user_id, v_actor_user_id)
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
    v_actor_user_id, v_actor_kind, v_actor_ref, _raw_payload, v_now
  );

  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB, TEXT, TEXT
) IS
  'Authoritative payment state machine. Deny-by-default body-side gate: service_role, or user_can_access_microgrid() on the line item''s billing period. The audit actor triple (actor_user_id / actor_kind / actor_ref) is derived server-side for session callers — the caller-supplied values are ignored — and passed through for service_role, which has no session to derive from.';

-- Defensive re-grant. CREATE OR REPLACE preserves privileges; mirroring the
-- 00032 / 00041 / 00045 pattern keeps the grant explicit at the migration
-- boundary. `authenticated` is intentionally retained — see header.
GRANT EXECUTE ON FUNCTION fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB, TEXT, TEXT
) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION fn_apply_payment_event(
  UUID, billing_line_item_payment_status, TEXT, UUID, JSONB, TEXT, TEXT
) FROM PUBLIC, anon;
