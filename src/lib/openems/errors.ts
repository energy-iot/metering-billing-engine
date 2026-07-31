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
// "OPENEMS_REDIRECT" (502) — backend answered with a 3xx; not followed (mbe-docs#8)
// "OPENEMS_INVALID_CONFIG" (503) — missing or malformed config
// "OPENEMS_NOT_CONFIGURED" (409) — microgrid has no ems_type set
// "OPENEMS_FORBIDDEN" (403) — caller lacks access to decrypt secret
// "DEVICE_INVALID_DATA_SOURCE" (400) — device config malformed
