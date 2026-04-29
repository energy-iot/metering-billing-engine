-- 00034_household_rpc_widen_pdf_fields.sql
-- PDF Invoices (#205 / PDF3): widen fn_create_household + the
-- fn_create_household_with_meter wrapper so the Add Household wizard and
-- POST /api/households/with-meter route can persist the 5 PDF1a (#202)
-- columns at create time:
--
--   p_account_number, p_meter_serial, p_meter_type,
--   p_customer_type,  p_contact_email
--
-- All 5 are trailing optional parameters with DEFAULT NULL. Existing
-- callers (legacy 13-arg invocations) continue to work unchanged.
--
-- ── Why DROP-then-CREATE on both signatures ──────────────────────────────
--
-- `CREATE OR REPLACE FUNCTION` only replaces a function with the EXACT
-- arg-type list. Adding 5 new args produces a NEW 18-arg overload alongside
-- the existing 13-arg one — which is precisely the PostgREST overload-
-- ambiguity that #158 / migration 00023 already had to fix:
--
--   "Could not choose the best candidate function between:
--      public.fn_create_household_with_meter(uuid,text,uuid,text,text,...)  -- 13-arg
--      public.fn_create_household_with_meter(uuid,text,uuid,text,text,...)  -- 18-arg
--    "
--
-- Fix mirrors 00023: DROP both 13-arg signatures FIRST, then CREATE OR
-- REPLACE both 18-arg signatures. supabase-js passes explicit values for
-- all named params (the route in src/app/api/households/with-meter/route.ts
-- forwards every key on `rpcArgs`), so resolution is unambiguous post-drop.
--
-- ── Wrapper relationship (mirrors 00026) ─────────────────────────────────
--
-- Post-#158 (migration 00026), `fn_create_household_with_meter` is a thin
-- wrapper that delegates to `fn_create_household` with a non-null
-- p_device_id. The widening propagates: the wrapper accepts the 5 new
-- params and forwards them verbatim to `fn_create_household`.
--
-- ── NULL-vs-DEFAULT for meter_type / customer_type ───────────────────────
--
-- PDF1a (#202 / migration 00033) added:
--   meter_type    TEXT NOT NULL DEFAULT 'Smart Submeter'
--   customer_type TEXT NOT NULL DEFAULT 'residential'
--
-- The column DEFAULT only applies when the INSERT OMITS the column.
-- Supplying a NULL VALUE bypasses the DEFAULT and would violate NOT NULL.
-- The wizard / edit dialog operator can leave these blank and the route
-- will pass the form's "" → null path through to the RPC, so the RPC body
-- uses COALESCE(p_meter_type, 'Smart Submeter') (and the analogous
-- 'residential' for customer_type) inside the INSERT to honor the DEFAULT
-- semantics explicitly.
--
-- ── Idempotency ──────────────────────────────────────────────────────────
--
-- DROP FUNCTION IF EXISTS — safe to re-run. The CREATE OR REPLACE that
-- follows always executes; if the function exists at the new arity it's
-- replaced. GRANT EXECUTE is unconditional and idempotent in Postgres.

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Drop the existing 13-arg signatures (per 00023 precedent).
-- ═════════════════════════════════════════════════════════════════════════

DROP FUNCTION IF EXISTS fn_create_household_with_meter(
  UUID,    -- p_microgrid_id
  TEXT,    -- p_display_name
  UUID,    -- p_device_id
  TEXT,    -- p_primary_phone
  TEXT,    -- p_primary_email
  TEXT,    -- p_address_line1
  TEXT,    -- p_address_line2
  TEXT,    -- p_unit_label
  TEXT,    -- p_address_city
  TEXT,    -- p_address_region
  TEXT,    -- p_address_country
  TEXT,    -- p_address_postal_code
  TEXT     -- p_geography_notes
);

DROP FUNCTION IF EXISTS fn_create_household(
  UUID,    -- p_microgrid_id
  TEXT,    -- p_display_name
  UUID,    -- p_device_id
  TEXT,    -- p_primary_phone
  TEXT,    -- p_primary_email
  TEXT,    -- p_address_line1
  TEXT,    -- p_address_line2
  TEXT,    -- p_unit_label
  TEXT,    -- p_address_city
  TEXT,    -- p_address_region
  TEXT,    -- p_address_country
  TEXT,    -- p_address_postal_code
  TEXT     -- p_geography_notes
);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Recreate fn_create_household with 18 args (13 existing + 5 new).
-- ═════════════════════════════════════════════════════════════════════════
--
-- Signature shape preserved from 00026; the 5 new trailing optional params
-- (account_number, meter_serial, meter_type, customer_type, contact_email)
-- correspond directly to the columns added by 00033 (PDF1a).
--
-- Body is otherwise identical to 00026: phone-required guard (#155),
-- device-belongs-to-microgrid + consumption_meter guards (only when
-- p_device_id is non-null), then INSERT into households, then optional
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
  p_customer_type       TEXT    DEFAULT NULL,
  p_contact_email       TEXT    DEFAULT NULL
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
    customer_type,
    contact_email
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
    COALESCE(p_customer_type, 'residential'),
    p_contact_email
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
-- 3. Recreate fn_create_household_with_meter wrapper with 18 args.
-- ═════════════════════════════════════════════════════════════════════════
--
-- Mirrors 00026's wrapper shape — delegates to fn_create_household with
-- a non-null p_device_id and forwards the 5 new params verbatim.

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
  p_customer_type       TEXT    DEFAULT NULL,
  p_contact_email       TEXT    DEFAULT NULL
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
    p_customer_type       => p_customer_type,
    p_contact_email       => p_contact_email
  );
END;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 4. Re-grant EXECUTE on both new 18-arg signatures.
-- ═════════════════════════════════════════════════════════════════════════

GRANT EXECUTE ON FUNCTION fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION fn_create_household(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;

GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, TEXT, TEXT, TEXT
) TO service_role;
