-- 00055_timezone_columns.sql
-- Issue #354 (timezone-awareness T1, anchor #353): per-microgrid + per-period
-- timezone columns, plus a BEFORE INSERT stamp trigger on billing_periods.
--
-- Expand-only / behavior-preserving (backward-compat AC on #354):
--
--   * `microgrids.timezone`      TEXT NOT NULL DEFAULT 'UTC' — the operator-
--     configured zone that drives NEW billing periods. Existing rows backfill
--     to 'UTC' via the DEFAULT, which is accurate: every period billed so far
--     genuinely was computed in UTC.
--   * `billing_periods.timezone` TEXT NOT NULL DEFAULT 'UTC' — the immutable
--     per-period record of the zone the period was computed in.
--
-- Type is TEXT, not an enum/CHECK: the IANA zone set (~350 names) evolves
-- with tzdata releases; validation is app-level and lands in T3 (#356) — if
-- T3's validation strategy changes, revisit this header, not this DDL.
--
-- The trigger stamps `NEW.timezone` from the parent microgrid and IGNORES any
-- client-supplied value. Periods are created from multiple call sites today
-- (client-side insert in BillingPeriodList.tsx, internal route
-- api/internal/billing-periods/route.ts) and more may appear; a DB trigger
-- covers all present + future paths, making "no per-period timezone override"
-- a database guarantee rather than a UI convention.
--
-- SECURITY INVOKER (NOT DEFINER): the function runs as the inserting caller,
-- who can already read their own microgrid via RLS — inserting a
-- billing_period requires microgrid-chain access under the FOR ALL policies,
-- so the SELECT below always sees the parent row. `microgrid_id` is a
-- NOT NULL FK, so the COALESCE('UTC') arm is unreachable in practice; it is
-- belt-and-braces only (e.g. a future path where the microgrid row is
-- invisible to the invoker).
--
-- SET search_path = public, pg_temp: guards against search_path injection,
-- consistent with every other function in this schema.
--
-- No REVOKE/GRANT dance: that convention applies to SECURITY DEFINER
-- functions (see CLAUDE.md § Migration conventions). This fn is INVOKER and
-- RETURNS TRIGGER — Postgres refuses direct invocation of trigger functions,
-- and PostgREST does not expose them as RPC.
--
-- Idempotent: CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS + CREATE
-- TRIGGER, so supabase db reset (which replays all migrations) is safe.
-- ADD COLUMN IF NOT EXISTS for the same reason.

-- ── 1. Columns ────────────────────────────────────────────────────────────────

ALTER TABLE microgrids
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

ALTER TABLE billing_periods
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC';

-- ── 2. Trigger function ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION fn_billing_period_stamp_timezone()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Unconditional assignment: any client-supplied NEW.timezone is discarded.
  NEW.timezone := COALESCE(
    (SELECT timezone FROM microgrids WHERE id = NEW.microgrid_id),
    'UTC'
  );
  RETURN NEW;
END;
$$;

-- ── 3. Trigger on billing_periods ─────────────────────────────────────────────

-- DROP + CREATE is idempotent (safe for supabase db reset). We cannot use
-- CREATE OR REPLACE TRIGGER (Postgres 14 feature not universally available in
-- Supabase's managed Postgres versions).
DROP TRIGGER IF EXISTS trg_billing_period_stamp_timezone ON billing_periods;

CREATE TRIGGER trg_billing_period_stamp_timezone
  BEFORE INSERT ON billing_periods
  FOR EACH ROW
  EXECUTE FUNCTION fn_billing_period_stamp_timezone();
