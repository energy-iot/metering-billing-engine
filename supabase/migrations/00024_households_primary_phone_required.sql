-- 00024_households_primary_phone_required.sql
-- Households: require primary_phone NOT NULL (#155).
--
-- Migration number is next-available-at-commit-time — bump if a collision
-- lands between ticket creation and merge.
--
-- ── Why ───────────────────────────────────────────────────────────────────────
--
-- Pesapal `submitOrder` requires `billing_address.email_address` OR
-- `phone_number`. Today both are NULLable, and we hit a 400 `missing_contact`
-- in production when a household had neither. Rather than enforce
-- "at-least-one" via a CHECK, the user (Alejandro, 2026-04-25) decided phone
-- should be mandatory outright: WhatsApp delivery is the canonical pilot path
-- and email is a nice-to-have. This eliminates the only remaining branch
-- where Pesapal can reject for missing contact.
--
-- `households.primary_phone` is a household-level field — semantically "who do
-- we WhatsApp the bill to" (typically the head of household).
--
-- Pre-prod: there are no real users. Backfill is a hard-reset of any household
-- with `primary_phone IS NULL`, plus its dependent rows (household_devices,
-- billing_line_items). Explicitly authorized by the user.
--
-- ── Behavior ──────────────────────────────────────────────────────────────────
--
-- 1. DELETE dependent rows for households with NULL primary_phone:
--      - household_devices (FK households)
--      - billing_line_items (FK households via household_id)
-- 2. DELETE households with NULL primary_phone.
-- 3. ALTER TABLE households ALTER COLUMN primary_phone SET NOT NULL.
-- 4. Re-issue fn_create_household_with_meter (13-arg signature from 00022)
--    with a defense-in-depth RAISE EXCEPTION 'household_phone_required'.
--    Re-grant EXECUTE to authenticated and service_role.
--
-- primary_email stays NULLable — explicitly out of scope for #155.
--
-- ── Cross-ticket coordination ────────────────────────────────────────────────
--
-- #158 introduces a new `fn_create_household` (no-meter path) and rewrites
-- fn_create_household_with_meter as a thin wrapper. The phone check this
-- migration adds to fn_create_household_with_meter will be SUPERSEDED when
-- 00025's wrapper rewrite delegates to fn_create_household. #158 owns
-- preserving the rule across that rewrite. Net behavior unchanged; do not
-- double-raise.

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Hard-reset rows that violate the new constraint.
-- ═════════════════════════════════════════════════════════════════════════════

DELETE FROM household_devices
 WHERE household_id IN (
   SELECT id FROM households WHERE primary_phone IS NULL
 );

DELETE FROM billing_line_items
 WHERE household_id IN (
   SELECT id FROM households WHERE primary_phone IS NULL
 );

DELETE FROM households
 WHERE primary_phone IS NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Tighten the column.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE households
  ALTER COLUMN primary_phone SET NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Re-issue fn_create_household_with_meter with the phone-required guard.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Signature must match 00022 exactly (13 args). We add a single guard at the
-- top of the body that raises 'household_phone_required' when p_primary_phone
-- is NULL or whitespace-only. The route validates BEFORE calling this RPC
-- (defense-in-depth), but the RPC stays self-defending so non-route callers
-- (bulk imports, scripts, future API consumers) cannot bypass the rule.

CREATE OR REPLACE FUNCTION fn_create_household_with_meter(
  p_microgrid_id        UUID,
  p_display_name        TEXT,
  p_device_id           UUID,
  p_primary_phone       TEXT    DEFAULT NULL,
  p_primary_email       TEXT    DEFAULT NULL,
  p_address_line1       TEXT    DEFAULT NULL,
  p_address_line2       TEXT    DEFAULT NULL,
  p_unit_label          TEXT    DEFAULT NULL,
  p_address_city        TEXT    DEFAULT NULL,
  p_address_region      TEXT    DEFAULT NULL,
  p_address_country     TEXT    DEFAULT NULL,
  p_address_postal_code TEXT    DEFAULT NULL,
  p_geography_notes     TEXT    DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  _household_id UUID;
BEGIN
  -- Guard 0 (#155): phone is required for Pesapal billing-address contact.
  IF p_primary_phone IS NULL OR trim(p_primary_phone) = '' THEN
    RAISE EXCEPTION 'household_phone_required';
  END IF;

  -- Guard 1: device's edge must belong to the target microgrid.
  IF NOT EXISTS (
    SELECT 1
    FROM devices d
    JOIN edges e ON e.id = d.edge_id
    WHERE d.id = p_device_id
      AND e.microgrid_id = p_microgrid_id
  ) THEN
    RAISE EXCEPTION
      'device % does not belong to microgrid %',
      p_device_id, p_microgrid_id;
  END IF;

  -- Guard 2: device must be of type consumption_meter.
  IF (SELECT device_type FROM devices WHERE id = p_device_id) <> 'consumption_meter' THEN
    RAISE EXCEPTION
      'device % is not a consumption_meter',
      p_device_id;
  END IF;

  -- Atomic insert pair. RLS on households and household_devices applies via
  -- SECURITY INVOKER. A denial raises 42501 which propagates up to the caller.
  INSERT INTO households (
    microgrid_id,
    display_name,
    primary_phone,
    primary_email,
    address_line1,
    address_line2,
    unit_label,
    address_city,
    address_region,
    address_country,
    address_postal_code,
    geography_notes
  ) VALUES (
    p_microgrid_id,
    p_display_name,
    p_primary_phone,
    p_primary_email,
    p_address_line1,
    p_address_line2,
    p_unit_label,
    p_address_city,
    p_address_region,
    p_address_country,
    p_address_postal_code,
    p_geography_notes
  )
  RETURNING id INTO _household_id;

  INSERT INTO household_devices (household_id, device_id, role)
  VALUES (_household_id, p_device_id, 'primary_consumption_meter');

  RETURN _household_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════════
-- 4. Re-grant EXECUTE on the 13-arg signature (idempotent).
-- ═════════════════════════════════════════════════════════════════════════════
--
-- CREATE OR REPLACE preserves grants for the same signature, but we restate
-- them here so the migration is self-documenting and safe to re-run after a
-- future signature change.

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;
