-- 00007_devices_dedup.sql
-- Devices dedup constraint documentation and index for F #57 (Discover devices).
--
-- The UNIQUE (edge_id, openems_component_id) constraint was already added in
-- 00001_schema.sql (AB #50). The channel address (openems_channel_address) used
-- as the dedup key in the Discover flow is derived deterministically from
-- openems_component_id as `{openems_component_id}/ActiveConsumptionEnergy`, so
-- the existing constraint covers the dedup requirement.
--
-- This migration adds a composite index to accelerate the dedup lookup in the
-- GET /api/openems/discover route (checking which components are already saved),
-- and a comment to make the dedup semantics explicit.

-- Index for fast dedup lookup in the Discover flow:
--   SELECT openems_component_id FROM devices
--   WHERE edge_id = $1 AND openems_component_id = ANY($2)
CREATE INDEX IF NOT EXISTS idx_devices_edge_component
  ON devices (edge_id, openems_component_id)
  WHERE openems_component_id IS NOT NULL;

COMMENT ON CONSTRAINT devices_edge_id_openems_component_id_key ON devices IS
  'Dedup key for the Discover devices flow (F #57). Channel address is derived '
  'from openems_component_id as {componentId}/ActiveConsumptionEnergy, making '
  'this constraint equivalent to UNIQUE (edge_id, openems_channel_address).';
