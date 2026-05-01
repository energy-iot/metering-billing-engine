// Health-derivation helper for the OpenEMS Backend tab (#102, #215).
//
// Derives one of three health states from the microgrid's ems_* fields
// (post-#215 — 24h "stale" cliff dropped):
//
//   ems_type IS NULL                                                 → not_configured
//   ems_last_discover_status IN ('auth_failed','unreachable',
//                                'zero_edges','unknown_error')       → failing
//   else                                                             → healthy  (fail-open;
//                                                                      absorbs `success`
//                                                                      regardless of age,
//                                                                      AND the catch-all
//                                                                      "configured but no
//                                                                      recognized status")
//
// "Not connected" copy is strictly reserved for `ems_type IS NULL`.
// Pure — no DB access. Callers (layout, page) each fetch the fields.

export type OpenemsBackendHealth =
  | "healthy"
  | "failing"
  | "not_configured";

export type HealthInput = {
  ems_type: "cloud_aws" | "direct_url" | null;
  ems_last_discover_at: string | null;
  ems_last_discover_status: string | null;
} | null;

export function deriveOpenemsBackendHealth(
  row: HealthInput,
  _now: Date = new Date()
): OpenemsBackendHealth {
  if (!row) return "not_configured";
  if (!row.ems_type) return "not_configured";

  const status = row.ems_last_discover_status;

  if (
    status === "auth_failed" ||
    status === "unreachable" ||
    status === "zero_edges" ||
    status === "unknown_error"
  ) {
    return "failing";
  }

  // Fail-open (#215): `success` (any age) and the catch-all "configured but
  // no recognized discover status" (including NULL) both read healthy.
  // "Not connected" is strictly reserved for `ems_type IS NULL`.
  return "healthy";
}
