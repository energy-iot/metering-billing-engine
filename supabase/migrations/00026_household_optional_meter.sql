-- 00026_household_optional_meter.sql
-- Households: support manual-billing without an OpenEMS meter (#158).
--
-- ── Why ──────────────────────────────────────────────────────────────────
--
-- Aaron's reality on the ground (Kisakye, 2026-04-25): not every tenant has
-- a metered connection. Some communities run a mix of metered + un-metered
-- tenants for years before full meter rollout. Today MBE forces him to lie
-- about un-metered tenants (link to a fake "shared" meter) or omit them
-- entirely — both are wrong.
--
-- User direction: "For now, just make it optional to integrate to a meter
-- from openEMS." Minimum viable: meter at create time is optional; manual
-- usage entry on the billing line item makes the household billable.
--
-- ── Behavior changes ─────────────────────────────────────────────────────
--
-- 1. NEW RPC `fn_create_household` accepts `p_device_id UUID DEFAULT NULL`
--    plus the same 12 other args as `fn_create_household_with_meter`.
--    When p_device_id is non-null it performs the existing meter-belongs-
--    to-microgrid + consumption_meter validation and inserts a
--    household_devices(role='primary_consumption_meter') row. When NULL
--    the device wiring is skipped entirely.
--    Inherits the #155 `household_phone_required` rule unchanged — the
--    same EXCEPTION name; routes upstream already handle it.
--
-- 2. `fn_create_household_with_meter` is rewritten as a thin wrapper that
--    delegates to fn_create_household with a non-null _device_id. The
--    13-arg signature is preserved so existing callers (the API route)
--    continue to work. The phone-check moves into the wrapped function;
--    it remains effectively guarded because the wrapper passes phone
--    through unchanged.
--
-- 3. `billing_line_items.usage_kwh` is altered from NOT NULL DEFAULT 0 to
--    NULLable. Reason: un-metered households need to differentiate "not
--    yet entered manually" (NULL) from "entered as 0" (legitimate zero
--    usage). Existing rows have non-null values so the ALTER is safe; the
--    DEFAULT 0 stays in place so metered Refresh-Readings inserts that
--    omit the column still write 0 implicitly. (`device_id`, `start_kwh`,
--    `end_kwh` are already nullable per 00001.)
--
-- ── #155 dependency ──────────────────────────────────────────────────────
--
-- This migration assumes 00024 (phone-required) is applied. The new
-- fn_create_household raises the same `household_phone_required` exception
-- name introduced there. The wrapper preserves the rule transitively.
--
-- ── Cross-ticket coordination ────────────────────────────────────────────
--
-- 00024 added the phone-required guard to fn_create_household_with_meter
-- inline. This migration MOVES the guard into fn_create_household and the
-- wrapper delegates — net behavior unchanged; do not double-raise.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Make billing_line_items.usage_kwh NULLable.
-- ═════════════════════════════════════════════════════════════════════════
--
-- DEFAULT 0 stays in place: `INSERT INTO billing_line_items (...)` calls
-- that omit usage_kwh continue to write 0 (matches legacy Refresh Readings
-- behavior). NULL is now permitted for un-metered "awaiting manual entry"
-- rows.

ALTER TABLE billing_line_items
  ALTER COLUMN usage_kwh DROP NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Create fn_create_household (no-meter capable, p_device_id DEFAULT NULL).
-- ═════════════════════════════════════════════════════════════════════════
--
-- Same 13-arg shape as fn_create_household_with_meter, but p_device_id is
-- NULLable with a DEFAULT NULL. When non-null, performs the meter-belongs-
-- to-microgrid + consumption_meter checks and inserts the household_devices
-- row. When NULL, skips the device wiring entirely.

CREATE OR REPLACE FUNCTION fn_create_household(
  p_microgrid_id        UUID,
  p_display_name        TEXT,
  p_device_id           UUID    DEFAULT NULL,
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
  -- Same exception name as 00024 — do not invent a new code.
  IF p_primary_phone IS NULL OR trim(p_primary_phone) = '' THEN
    RAISE EXCEPTION 'household_phone_required';
  END IF;

  -- Guards 1 + 2 only apply when a device is being linked.
  IF p_device_id IS NOT NULL THEN
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
  END IF;

  -- Atomic insert (+ optional device link). RLS on households /
  -- household_devices applies via SECURITY INVOKER. A denial raises 42501
  -- which propagates up to the caller.
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

  IF p_device_id IS NOT NULL THEN
    INSERT INTO household_devices (household_id, device_id, role)
    VALUES (_household_id, p_device_id, 'primary_consumption_meter');
  END IF;

  RETURN _household_id;
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Rewrite fn_create_household_with_meter as a thin wrapper.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Signature unchanged from 00022/00024 (13 args). Body now delegates to
-- fn_create_household with the same args + non-null _device_id. The
-- phone-required guard lives in fn_create_household — the wrapper passes
-- p_primary_phone through unchanged so the rule remains in effect.

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
BEGIN
  RETURN fn_create_household(
    p_microgrid_id        => p_microgrid_id,
    p_display_name        => p_display_name,
    p_device_id           => p_device_id,
    p_primary_phone       => p_primary_phone,
    p_primary_email       => p_primary_email,
    p_address_line1       => p_address_line1,
    p_address_line2       => p_address_line2,
    p_unit_label          => p_unit_label,
    p_address_city        => p_address_city,
    p_address_region      => p_address_region,
    p_address_country     => p_address_country,
    p_address_postal_code => p_address_postal_code,
    p_geography_notes     => p_geography_notes
  );
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Re-grant EXECUTE on both signatures (idempotent).
-- ═════════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;
