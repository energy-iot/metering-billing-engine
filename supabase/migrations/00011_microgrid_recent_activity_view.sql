-- 00011_microgrid_recent_activity_view.sql
--
-- VIEW: microgrid_recent_activity
--
-- Surfaces DB-derivable lifecycle events for a microgrid's Activity Log widget.
-- Uses security_invoker = true so RLS on the underlying tables is evaluated
-- with the calling user's credentials — cross-org access is blocked by the same
-- policies that protect the base tables.
--
-- UNIONs four event sources:
--   1. billing_periods opened  (created_at)
--   2. billing_periods closed  (closed_at, only when NOT NULL)
--   3. households created      (created_at)
--   4. devices created         (created_at), rolled up per (edge, hour)
--
-- Columns:
--   microgrid_id UUID
--   kind         TEXT   — 'period_opened' | 'period_closed' | 'household_added' | 'devices_discovered'
--   timestamp    TIMESTAMPTZ
--   description  TEXT   — human-readable, e.g. "Period opened: 2026-04-01 – 2026-04-30"
--
-- ORDER BY timestamp DESC, kind ASC (deterministic tie-break on equal timestamps).

CREATE OR REPLACE VIEW microgrid_recent_activity
  WITH (security_invoker = true)
AS
  -- 1. Billing period opened
  SELECT
    bp.microgrid_id,
    'period_opened'::TEXT AS kind,
    bp.created_at         AS timestamp,
    'Period opened: ' || bp.start_date::TEXT || ' – ' || bp.end_date::TEXT AS description
  FROM billing_periods bp

  UNION ALL

  -- 2. Billing period closed (only rows where closed_at is set)
  SELECT
    bp.microgrid_id,
    'period_closed'::TEXT AS kind,
    bp.closed_at          AS timestamp,
    'Period closed: ' || bp.start_date::TEXT || ' – ' || bp.end_date::TEXT AS description
  FROM billing_periods bp
  WHERE bp.closed_at IS NOT NULL

  UNION ALL

  -- 3. Household created
  SELECT
    hh.microgrid_id,
    'household_added'::TEXT AS kind,
    hh.created_at           AS timestamp,
    'Household added: ' || hh.display_name AS description
  FROM households hh

  UNION ALL

  -- 4. Devices created — rolled up per (edge, hour) to avoid per-device noise
  --    COUNT(*) lets the description say "Discovered N devices on <edge name>"
  SELECT
    e.microgrid_id,
    'devices_discovered'::TEXT                                               AS kind,
    date_trunc('hour', d.created_at)                                         AS timestamp,
    'Discovered ' || COUNT(*)::TEXT || ' device(s) on ' || e.name            AS description
  FROM devices d
  JOIN edges e ON e.id = d.edge_id
  GROUP BY e.microgrid_id, e.name, date_trunc('hour', d.created_at)

ORDER BY timestamp DESC, kind ASC;
