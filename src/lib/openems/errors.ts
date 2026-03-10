export class OpenEmsError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "OpenEmsError";
  }
}

// Error codes:
// "OPENEMS_UNREACHABLE" (503) — fetch failed (network error, timeout)
// "OPENEMS_AUTH_FAILED" (401) — 401 from B2B REST
// "OPENEMS_RPC_ERROR" (502) — JSON-RPC error response
// "OPENEMS_INVALID_CONFIG" (503) — missing env vars
// "METER_NO_DATA_SOURCE" (400) — meter has no data_source_config
// "METER_INVALID_DATA_SOURCE" (400) — data_source_config malformed
