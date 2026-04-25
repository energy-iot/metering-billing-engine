-- 00022_households_address_fields.sql
-- Households schema widening: 5 address columns (#146).
--
-- Migration number is next-available-at-commit-time — bump if a collision
-- lands between ticket creation and merge.
--
-- ── Summary ───────────────────────────────────────────────────────────────────
--
-- Sibling entities (organizations, communities, microgrids) already have the
-- canonical 5-column address shape (address_city, address_region,
-- address_country, address_postal_code, geography_notes — see 00001_schema.sql
-- ~lines 100-110 for the pattern). This migration extends households to match.
--
-- The new columns are optional (NULL). No backfill. Existing rows are valid.
--
-- fn_create_household_with_meter is widened with 5 new trailing optional params
-- and the GRANT EXECUTE is re-issued with the full new arg-type list. This is
-- required because Postgres treats functions with different signatures as
-- distinct — the prior GRANT on the 8-arg signature does NOT carry over to the
-- 13-arg signature. Missing the re-grant causes 42501 errors at runtime.
--
-- ── Designer reference ────────────────────────────────────────────────────────
-- mbe-docs/design/mocks/household-and-edge-disambig-2026-04-25/
--   02-household-edit-dialog.tsx  — AddressSubsection layout
--   04-household-table-after.tsx  — addressSummary format
--
-- ── Idempotency ───────────────────────────────────────────────────────────────
-- ADD COLUMN IF NOT EXISTS — safe to re-run.
-- CREATE OR REPLACE FUNCTION — safe to re-run.
-- GRANT EXECUTE — idempotent (Postgres allows duplicate GRANTs).

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Add 5 address columns to households.
-- ═════════════════════════════════════════════════════════════════════════════

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS address_city         TEXT NULL,
  ADD COLUMN IF NOT EXISTS address_region       TEXT NULL,
  ADD COLUMN IF NOT EXISTS address_country      TEXT NULL,
  ADD COLUMN IF NOT EXISTS address_postal_code  TEXT NULL,
  ADD COLUMN IF NOT EXISTS geography_notes      TEXT NULL;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. Widen fn_create_household_with_meter with 5 new optional params.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- SECURITY INVOKER and SET search_path preserved from the original migration
-- (00009_create_household_with_meter_rpc.sql). Safety guards (device belongs
-- to microgrid, device is consumption_meter) are unchanged.

CREATE OR REPLACE FUNCTION fn_create_household_with_meter(
  p_microgrid_id        UUID,
  p_display_name        TEXT,
  p_device_id           UUID,
  p_primary_phone       TEXT    DEFAULT NULL,
  p_primary_email       TEXT    DEFAULT NULL,
  p_address_line1       TEXT    DEFAULT NULL,
  p_address_line2       TEXT    DEFAULT NULL,
  p_unit_label          TEXT    DEFAULT NULL,
  -- New optional params added in #146 ─────────────────────────────────────
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
-- 3. Re-grant EXECUTE with the full new 13-arg signature.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- CRITICAL: Postgres resolves GRANTs by the full arg-type list. The prior
-- GRANT on (UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT) does NOT
-- automatically apply to the new 13-arg overload. Both GRANTs are kept
-- (existing callers that pass 8 args still work); the new 13-arg signature
-- must be independently granted so the route's RPC call succeeds.

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;
