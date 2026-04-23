export class PesapalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PesapalError";
  }
}

// Error codes:
// "PESAPAL_INVALID_CONFIG" (503) — missing env vars (consumer key / secret)
// "PESAPAL_AUTH_FAILED"    (401) — auth token request failed
// "PESAPAL_HTTP_ERROR"     (502) — non-2xx from Pesapal
// "PESAPAL_NO_IPN"         (400) — no IPN registrations on the account
// "PESAPAL_UNREACHABLE"    (503) — network/fetch failure
