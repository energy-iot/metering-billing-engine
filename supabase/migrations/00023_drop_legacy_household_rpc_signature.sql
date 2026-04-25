-- 00023_drop_legacy_household_rpc_signature.sql
-- Drop the legacy 8-arg fn_create_household_with_meter signature.
--
-- ── Why ───────────────────────────────────────────────────────────────────────
--
-- Migration 00022 widened fn_create_household_with_meter to a 13-arg signature
-- (added 5 optional address fields). It used CREATE OR REPLACE FUNCTION, which
-- only replaces a function with the *exact same* arg-type list. The original
-- 8-arg signature from 00009 was therefore left in place alongside the new
-- 13-arg one.
--
-- PostgREST cannot pick a candidate when the client calls the function with
-- only the 8-arg subset (or with NULLs in positions where both signatures
-- accept TEXT). The 4-step Add Household wizard hits this every call:
--
--   "Could not choose the best candidate function between:
--      public.fn_create_household_with_meter(uuid,text,uuid,text,text,text,text,text),
--      public.fn_create_household_with_meter(uuid,text,uuid,text,text,text,text,text,text,text,text,text,text)"
--
-- Fix: drop the 8-arg signature. The 13-arg version handles every legacy call
-- — the 5 new params have no DEFAULT but the supabase-js client passes
-- explicit `null` for missing fields, so resolution is unambiguous after the
-- drop.
--
-- ── Idempotency ───────────────────────────────────────────────────────────────
-- DROP FUNCTION IF EXISTS — safe to re-run; no-op if already dropped.

DROP FUNCTION IF EXISTS fn_create_household_with_meter(
  UUID,    -- p_microgrid_id
  TEXT,    -- p_display_name
  UUID,    -- p_device_id
  TEXT,    -- p_primary_phone
  TEXT,    -- p_primary_email
  TEXT,    -- p_address_line1
  TEXT,    -- p_address_line2
  TEXT     -- p_unit_label
);
