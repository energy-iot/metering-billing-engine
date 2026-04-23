// Health-derivation helper for the OpenEMS Backend tab (#102).
//
// Derives one of four health states from the microgrid's ems_* fields per
// AC-HEALTH-DERIVATION:
//
//   ems_type IS NULL                                                 → not_configured
//   ems_last_discover_status = 'success' AND < 24h ago               → healthy
//   ems_last_discover_status = 'success' AND ≥ 24h ago               → stale
//   ems_last_discover_status IN ('auth_failed','unreachable',
//                                'zero_edges','unknown_error')       → failing
//   all other cases                                                  → stale
//
// Pure — no DB access. Callers (layout, page) each fetch the fields.

export type OpenemsBackendHealth =
  | "healthy"
  | "stale"
  | "failing"
  | "not_configured";

export type HealthInput = {
  ems_type: "cloud_aws" | "direct_url" | null;
  ems_last_discover_at: string | null;
  ems_last_discover_status: string | null;
} | null;

const TWENTY_FOUR_HOURS_MS = 24 * 3600 * 1000;

export function deriveOpenemsBackendHealth(
  row: HealthInput,
  now: Date = new Date()
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

  if (status === "success") {
    if (!row.ems_last_discover_at) return "stale";
    const at = new Date(row.ems_last_discover_at).getTime();
    const diff = now.getTime() - at;
    return diff < TWENTY_FOUR_HOURS_MS ? "healthy" : "stale";
  }

  // Catch-all: configured but no recognized discover status (including null).
  return "stale";
}
