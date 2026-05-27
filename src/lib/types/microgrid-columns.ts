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

// Customerapp-boundary subset (#257). The full `MICROGRID_PUBLIC_COLUMNS`
// above is the operator-side public projection — wide enough to power the
// dashboard UI (20+ columns). Customerapp only needs to resolve UUIDs and
// the display name + currency for human-facing context; surfacing the wider
// set across the per-org token API boundary breaks the "minimum useful set,
// not full CRUD" principle and creates a future leak risk every time a new
// sensitive column lands on `microgrids` upstream.
//
// Use in `.select(...)` calls on the customerapp-facing `/api/v1/microgrids`
// endpoint. The two constants intentionally coexist — DO NOT collapse them.
//
// Declared `as const` so PostgREST's type machinery can narrow
// `.select(MICROGRID_PUBLIC_COLUMNS_FOR_CUSTOMERAPP)` to a precise
// `Pick<Microgrid, …>` row type.
export const MICROGRID_PUBLIC_COLUMNS_FOR_CUSTOMERAPP =
  "id, name, currency, community_id" as const;
