// Defense-in-depth: keep ems_aws_secret_access_key_encrypted (bytea ciphertext)
// out of any client-bound JSON or SSR HTML. See issue #106.
//
// This is the canonical `Microgrid` Row column list MINUS the one encrypted
// column. Use this constant in `.select(...)` calls on the `microgrids` table
// instead of `.select("*")`. For PostgREST embed queries, interpolate via
// template literal:
//
//   .select(`${MICROGRID_PUBLIC_COLUMNS}, communities!inner(org_id)`)
//
// Declared `as const` (single literal, no concatenation) so that Supabase's
// PostgREST type machinery can narrow `.select(MICROGRID_PUBLIC_COLUMNS)` to
// a `Pick<Microgrid, …>` row type — generic `string` would fall through to
// the error-shape fallback.
//
// Enforced by `src/lib/__tests__/no-microgrid-star-select.test.ts`.
export const MICROGRID_PUBLIC_COLUMNS =
  "id, community_id, name, currency, address_line1, address_line2, address_city, address_region, address_country, address_postal_code, lat, lng, created_at, ems_type, ems_backend_url, ems_aws_region, ems_aws_access_key_id, ems_known_edge_ids, ems_last_discover_at, ems_last_discover_count, ems_last_discover_error, ems_last_discover_status" as const;
