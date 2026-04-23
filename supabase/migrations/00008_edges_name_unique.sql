-- 00008_edges_name_unique.sql
-- Add UNIQUE constraint on (microgrid_id, name) for edges.
-- Prevents duplicate edge names within the same microgrid.
-- Returns Postgres error code 23505 on violation, which the API layer
-- maps to HTTP 409 with a human-readable message.

ALTER TABLE edges
  ADD CONSTRAINT edges_microgrid_name_unique UNIQUE (microgrid_id, name);
