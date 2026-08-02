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
// "OPENEMS_HTTP_ERROR" (502) — non-2xx that is not a redirect; carries the
//     status and the first bytes of the body (#325). Note OpenEMS reports an
//     authentication failure as 500 with the reason in the body, NOT as
//     401/403, so an auth failure against an OpenEMS Backend arrives here
//     rather than as OPENEMS_AUTH_FAILED — see the note in client.ts.
// "OPENEMS_NOT_JSON" (502) — 2xx whose body did not parse as JSON; carries the
//     content-type and the first bytes (#325). A reverse proxy serving an
//     error page or a single-page-app catch-all produces this.
// "OPENEMS_REDIRECT" (502) — backend answered with a 3xx; not followed (mbe-docs#8)
// "OPENEMS_INVALID_BACKEND_URL" (503) — stored backend URL failed sink-side
//     validation; typically a row written before the rules existed (mbe-docs#8)
// "OPENEMS_INVALID_CONFIG" (503) — missing or malformed config
// "OPENEMS_NOT_CONFIGURED" (409) — microgrid has no ems_type set
// "OPENEMS_FORBIDDEN" (403) — caller lacks access to decrypt secret
// "DEVICE_INVALID_DATA_SOURCE" (400) — device config malformed
