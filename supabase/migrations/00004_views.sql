-- 00004_views.sql
-- Read-only VIEWs layered on the entity-model schema (AB #50 + C #51).
--
-- IMPORTANT security invariant: every view defined here MUST use
--   WITH (security_invoker = true)
-- Postgres 15+ defaults views to SECURITY DEFINER mode, which means the view
-- runs as its OWNER (postgres) and BYPASSES the caller's RLS policies on
-- underlying tables — a cross-org data leak. security_invoker forces the
-- view to evaluate RLS using the CALLER's identity, which is what we want.
-- See https://www.postgresql.org/docs/15/sql-createview.html#SQL-CREATEVIEW-SECURITY.

-- ── microgrid_shared_devices ────────────────────────────────────────────
-- Devices on a microgrid's edges that are NOT linked to any household via
-- household_devices. These are "shared" devices (grid meter, PV inverter,
-- battery) whose consumption is microgrid-level, not household-level.
--
-- Column contract:
--   * All columns of `devices` (select d.*).
--   * `microgrid_id` joined from parent `edges` row for filtering.
--
-- Callers: Setup > Edges > Shared listing (microgrids/[id]/setup/edges/shared).

CREATE VIEW microgrid_shared_devices
WITH (security_invoker = true) AS
  SELECT d.*, e.microgrid_id
  FROM devices d
  JOIN edges e ON d.edge_id = e.id
  WHERE NOT EXISTS (
    SELECT 1 FROM household_devices hd WHERE hd.device_id = d.id
  );
