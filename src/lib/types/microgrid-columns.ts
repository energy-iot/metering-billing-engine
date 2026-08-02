import type { Microgrid } from "./domain";

// Defense-in-depth: keep ems_aws_secret_access_key_encrypted (bytea ciphertext)
// out of any client-bound JSON or SSR HTML. See issue #106.
//
// This is the canonical `Microgrid` Row column list MINUS the encrypted
// columns (the AWS secret, and since #327 the OpenEMS Basic password). Use
// this constant in `.select(...)` calls on the `microgrids` table instead of
// `.select("*")`. For PostgREST embed queries, interpolate via
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
  "id, community_id, name, currency, address_line1, address_line2, address_city, address_region, address_country, address_postal_code, lat, lng, created_at, created_by, ems_type, ems_backend_url, ems_aws_region, ems_aws_access_key_id, ems_basic_auth_username, ems_known_edge_ids, ems_last_discover_at, ems_last_discover_count, ems_last_discover_error, ems_last_discover_status" as const;

// The row type this projection yields. Declared here, beside the column list,
// because the two must exclude the same columns and previously did not have to:
// three call sites each spelled `Omit<Microgrid, "ems_aws_secret_access_key_encrypted">`
// by hand, which was correct only while there was exactly one secret column.
// #327 added a second and all three broke at once — the compiler caught it,
// but it caught it three times in three files for one decision.
//
// Add a sensitive column: leave it out of MICROGRID_PUBLIC_COLUMNS above and
// add it to the Omit below. Both edits are in this file and nowhere else.
//
// Note the two lists have OPPOSITE defaults, and reasoning from sensitivity
// gets one of them backwards: this projection is allow-by-enumeration, so a
// new column is excluded until named. The `ems_*` guard trigger
// (`fn_microgrids_guard_ems_config`) is deny-by-enumeration, so a new
// credential column is *unprotected* until named there. Same column, opposite
// action.
export type MicrogridPublic = Omit<
  Microgrid,
  "ems_aws_secret_access_key_encrypted" | "ems_basic_auth_password_encrypted"
>;

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
