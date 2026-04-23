-- 00008_entity_uniqueness.sql
-- Entity name uniqueness for UX4a (#76).
--
-- Adds a UNIQUE constraint on (community_id, name) for microgrids so two
-- microgrids in the same community cannot share a name. The API layer
-- catches Postgres error code 23505 on this constraint and returns a
-- user-facing 409 with the exact message:
--   "A microgrid named '{name}' already exists in this community."
--
-- Org and Community name uniqueness are explicitly NOT enforced here — see
-- Ticket #76 "Out of Scope". Two NFE-like orgs in different countries might
-- legitimately share a name, and the super_admin workflow for creating a
-- second org with the same display name would be friction without value.
--
-- Seed audit: 00003_seed.sql.template creates exactly one microgrid per
-- community (Kisakye in NFE), so this constraint cannot break seeded rows.

ALTER TABLE microgrids
  ADD CONSTRAINT microgrids_community_name_unique
  UNIQUE (community_id, name);

COMMENT ON CONSTRAINT microgrids_community_name_unique ON microgrids IS
  'Enforces per-community microgrid name uniqueness (UX4a / #76). API layer '
  'translates Postgres 23505 on this constraint into a 409 response.';
