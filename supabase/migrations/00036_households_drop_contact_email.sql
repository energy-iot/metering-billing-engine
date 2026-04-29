-- 00036_households_drop_contact_email.sql
-- PDF Invoices (#211 / PDF5): drop the duplicate `households.contact_email`
-- column added briefly by PDF1a (#202 / migration 00033) and reuse the
-- pre-existing `households.primary_email` (TEXT NULL since 00001).
--
-- ── Rationale ─────────────────────────────────────────────────────────────
--
-- PDF1a's migration introduced a parallel email field next to the day-one
-- `primary_email` column, mirroring the (already-fixed) `contact_phone` /
-- `primary_phone` duplication. The household form now renders BOTH
-- "Primary email" and "Contact email — for billing questions", which is
-- confusing for operators. No downstream code reads `contact_email` (the PDF
-- renderer's customer-support card sources the seller-side email from the
-- community-level `invoice_config.seller.contact_email` JSONB, not from the
-- household). Same-day cleanup: column shipped 2026-04-29 with PDF1a, dropped
-- the same week.
--
-- ── Statement order MATTERS ───────────────────────────────────────────────
--
-- Run order:
--   1. DROP both 18-arg function signatures (00034) — the function bodies
--      INSERT INTO households (..., contact_email) VALUES (..., p_contact_email),
--      so they must go FIRST or a transient state could 42703.
--   2. Defensive backfill — preserves any operator data that landed in
--      `contact_email` but not `primary_email`. No-op when zero such rows
--      (expected; same-day cleanup with at most a few test entries).
--   3. DROP CONSTRAINT then DROP COLUMN — explicit constraint drop is
--      idempotent and matches 00033's add-constraint pattern; column-drop
--      would cascade-drop the constraint anyway.
--   4. RECREATE both functions at the post-PDF5 17-arg arity (the 18-arg
--      shape from 00034 minus the trailing p_contact_email).
--   5. GRANT EXECUTE on both new 17-arg signatures to authenticated and
--      service_role — without GRANT, callers 403.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Drop both 18-arg signatures (per 00023 / 00034 precedent).
-- ═════════════════════════════════════════════════════════════════════════
--
-- Functions go FIRST so a transient state can't fire a stale function body
-- against a dropped column. Mirrors the 00023 / 00034 overload-collision
-- pattern: explicit arg-type list keeps PostgREST overload resolution
-- unambiguous.

DROP FUNCTION IF EXISTS fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
);

DROP FUNCTION IF EXISTS fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Defensive backfill — preserve any operator data only in contact_email.
-- ═════════════════════════════════════════════════════════════════════════
--
-- AFTER function-drop (so stale bodies cannot fire) and BEFORE column-drop
-- (so contact_email is still readable). Same-day cleanup; expected to be a
-- no-op in production.

UPDATE households
SET primary_email = contact_email
WHERE primary_email IS NULL AND contact_email IS NOT NULL;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Drop the format CHECK then the column.
-- ═════════════════════════════════════════════════════════════════════════

ALTER TABLE households DROP CONSTRAINT IF EXISTS households_contact_email_format;
ALTER TABLE households DROP COLUMN IF EXISTS contact_email;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Recreate fn_create_household at 17 args (drop trailing p_contact_email).
-- ═════════════════════════════════════════════════════════════════════════
--
-- Body matches 00034 verbatim except: the INSERT column list drops the
-- trailing `contact_email`, and the VALUES list drops the trailing
-- `p_contact_email`. All other behaviour preserved — phone-required guard
-- (#155), device-belongs-to-microgrid + consumption_meter guards (only when
-- p_device_id is non-null), COALESCE on meter_type/customer_type so a NULL
-- caller-arg honors the column DEFAULT explicitly, optional
-- household_devices link.

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
  p_geography_notes     TEXT    DEFAULT NULL,
  p_account_number      TEXT    DEFAULT NULL,
  p_meter_serial        TEXT    DEFAULT NULL,
  p_meter_type          TEXT    DEFAULT NULL,
  p_customer_type       TEXT    DEFAULT NULL
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
  -- household_devices applies via SECURITY INVOKER.
  --
  -- COALESCE on meter_type / customer_type so a NULL caller-arg honors the
  -- column DEFAULT explicitly (Postgres can't fall through to DEFAULT when
  -- a NULL VALUE is supplied).
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
    geography_notes,
    account_number,
    meter_serial,
    meter_type,
    customer_type
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
    p_geography_notes,
    p_account_number,
    p_meter_serial,
    COALESCE(p_meter_type,    'Smart Submeter'),
    COALESCE(p_customer_type, 'residential')
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
-- 5. Recreate fn_create_household_with_meter wrapper at 17 args.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Mirrors 00034's wrapper shape, minus the p_contact_email forward.

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
  p_geography_notes     TEXT    DEFAULT NULL,
  p_account_number      TEXT    DEFAULT NULL,
  p_meter_serial        TEXT    DEFAULT NULL,
  p_meter_type          TEXT    DEFAULT NULL,
  p_customer_type       TEXT    DEFAULT NULL
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
    p_geography_notes     => p_geography_notes,
    p_account_number      => p_account_number,
    p_meter_serial        => p_meter_serial,
    p_meter_type          => p_meter_type,
    p_customer_type       => p_customer_type
  );
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 6. Re-grant EXECUTE on both new 17-arg signatures.
-- ═════════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT
) TO service_role;
