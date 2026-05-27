// Defense-in-depth: minimum-useful-set subset of household columns surfaced
// to customerapp via `GET /api/v1/microgrids/:id/households` (#257).
//
// The `households` table carries PII fields (`primary_phone`, `primary_email`,
// address columns, `account_number`, `meter_serial`) that an operator-side
// dashboard query is welcome to read but the customerapp boundary must not.
// Per the Architect's "minimum-useful set, not full CRUD" principle for the
// customerapp API: surface only the entity ID, the human-facing display
// name, and the microgrid grouping key. Anything else requires an explicit
// ticket + design review and a separate constant.
//
// `microgrid_id` is included so a future feature could let customerapp list
// multiple microgrids' households in one call without losing the grouping.
// `has_device` is COMPUTED in JS (not a column) — see the route handler's
// `household_devices(device_id)` embed.
//
// Enforced by `src/lib/__tests__/no-household-star-select-customerapp.test.ts`
// — scoped to `src/app/api/v1/` only (the customerapp trust boundary).
// Operator-side `households` queries can `.select("*")` if they need to;
// the test does NOT scan operator-side code.
//
// Declared `as const` (single literal, no concatenation) so that Supabase's
// PostgREST type machinery can narrow
// `.select(HOUSEHOLD_PUBLIC_COLUMNS_FOR_CUSTOMERAPP)` to a precise
// `Pick<Household, …>` row type — generic `string` would fall through to
// the error-shape fallback.
export const HOUSEHOLD_PUBLIC_COLUMNS_FOR_CUSTOMERAPP =
  "id, display_name, microgrid_id" as const;
