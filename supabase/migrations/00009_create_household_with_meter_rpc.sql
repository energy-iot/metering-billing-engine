-- 00009_create_household_with_meter_rpc.sql
-- RPC used by the Add-Household 4-step wizard (UX2 / #74).
--
-- Creates a household and (mandatorily) links a primary_consumption_meter
-- device in a single atomic function call. A Postgres function = single
-- transaction, so if either insert fails (RLS denial, device mismatch,
-- partial unique index collision on household_one_primary_consumption_meter)
-- no orphaned household row is left behind.
--
-- SECURITY INVOKER: RLS applies to the caller. The wrapping API route
-- (`POST /api/households/with-meter`) invokes this via a user-bound server
-- client, so the caller's role_scoped access decides whether the row can be
-- written. search_path pinned to public, pg_temp per Supabase best practice.
--
-- Safety guards (both raise EXCEPTION):
--   1. Device's edge must belong to the target microgrid
--   2. Device must be of type consumption_meter

CREATE OR REPLACE FUNCTION fn_create_household_with_meter(
  p_microgrid_id   UUID,
  p_display_name   TEXT,
  p_device_id      UUID,
  p_primary_phone  TEXT DEFAULT NULL,
  p_primary_email  TEXT DEFAULT NULL,
  p_address_line1  TEXT DEFAULT NULL,
  p_address_line2  TEXT DEFAULT NULL,
  p_unit_label     TEXT DEFAULT NULL
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
  -- Prevents an operator from pointing a household at a device on another microgrid.
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
  -- Non-consumption devices (grid/PV/battery/etc.) are not billable loads.
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
    unit_label
  ) VALUES (
    p_microgrid_id,
    p_display_name,
    p_primary_phone,
    p_primary_email,
    p_address_line1,
    p_address_line2,
    p_unit_label
  )
  RETURNING id INTO _household_id;

  INSERT INTO household_devices (household_id, device_id, role)
  VALUES (_household_id, p_device_id, 'primary_consumption_meter');

  RETURN _household_id;
END;
$$;

-- Allow authenticated users to invoke. RLS on the underlying tables is the
-- real authorization gate; this GRANT only permits the function to be called.
GRANT EXECUTE ON FUNCTION fn_create_household_with_meter(
  UUID, TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT
) TO authenticated;
