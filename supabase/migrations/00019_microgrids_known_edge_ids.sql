-- Migration 00019: Add ems_known_edge_ids column to microgrids (#112)
--
-- Rationale: the B2B REST surface of OpenEMS does not expose a catalog-listing
-- method — getEdgesStatus([]) returns {} on real backends. The super_admin
-- knows their edge IDs from the OpenEMS setup script. We store them
-- explicitly so Save & test can validate each via getEdgesStatus([...ids])
-- and the Discover route can pass the persisted list instead of [].
--
-- NOT NULL DEFAULT '{}': the column always has a value; "not configured" is
-- still signalled by ems_type IS NULL. No code path should key off
-- ems_known_edge_ids IS NULL.
--
-- Idempotency: all statements are guarded with IF NOT EXISTS / DROP...IF EXISTS
-- so re-running this migration is safe.

ALTER TABLE microgrids
  ADD COLUMN IF NOT EXISTS ems_known_edge_ids TEXT[] NOT NULL DEFAULT '{}';

-- Named CHECK constraint: every element must be non-empty after trim.
-- Pattern mirrors microgrids_ems_backend_url_required in migration 00018
-- (lines 265-271).
--
-- Implementation note: PostgreSQL does not allow subqueries in CHECK
-- constraints (PG error 0A000). We enforce the invariant via a helper
-- function (IMMUTABLE, SECURITY INVOKER) instead.
ALTER TABLE microgrids DROP CONSTRAINT IF EXISTS microgrids_ems_known_edge_ids_nonempty_strings;

CREATE OR REPLACE FUNCTION fn_edge_ids_all_nonempty(ids TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT
    CASE WHEN cardinality(ids) = 0 THEN TRUE
         ELSE '' != ALL(array(SELECT btrim(e) FROM unnest(ids) e))
    END;
$$;

ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_ems_known_edge_ids_nonempty_strings
  CHECK (fn_edge_ids_all_nonempty(ems_known_edge_ids));
