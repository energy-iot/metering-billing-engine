/**
 * errors.ts — generic payment-provider error class.
 *
 * Parallel to `OpenEmsError` (src/lib/openems/errors.ts). The library layer
 * throws `PaymentError` at its outer boundary so callers (route handlers) can
 * map a single class to the `{ error, reason }` response shape without
 * reaching into provider-specific error types.
 *
 * Provider-specific errors (e.g. `PesapalError`) extend this class so the
 * factory/provider wrapper can either propagate the subclass unchanged or
 * re-throw as a plain `PaymentError` — both are caught by the same route
 * handler `instanceof PaymentError` check.
 */
export class PaymentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "PaymentError";
  }
}

// Generic codes (provider-agnostic):
//   "PAYMENT_NOT_CONFIGURED"    (409) — community has no provider set
//   "PAYMENT_FORBIDDEN"         (403) — caller may not decrypt the secret
//   "PAYMENT_INVALID_CONFIG"    (500) — stored config is malformed / partial
//   "PAYMENT_UNKNOWN_PROVIDER"  (500) — factory received an unknown provider
//                                        discriminator (exhaustiveness guard)
//
// Provider-specific codes live on the subclass and are mapped to a short
// `reason` string by the route handler.
