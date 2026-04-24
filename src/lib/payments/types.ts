/**
 * types.ts — provider-agnostic payment adapter types.
 *
 * Mirrors the shape of `src/lib/openems/index.ts`'s `OpenEmsClientConfig` +
 * `OpenEmsAuth` pattern: a discriminated union keyed on a provider string,
 * plus an interface every provider class implements.
 *
 * Adding a new provider is additive:
 *   1. Add `'stripe'` (etc.) to `PaymentProvider`.
 *   2. Add a new branch to `PaymentProviderConfig` with the shape that maps
 *      to `communities.payment_provider_config` for that provider.
 *   3. Implement a class that satisfies `PaymentProviderClient`.
 *   4. Extend the factory switch in `factory.ts`.
 *   5. Extend the config loader in `config.ts` if the shape differs.
 *
 * No schema migration or route refactor is needed for additional providers.
 */

import type { PesapalConfig } from "./pesapal/types";
import type { BillingAddress } from "./pesapal/types";

/** Provider discriminator — matches the `payment_provider_type` SQL enum. */
export type PaymentProvider = "pesapal";

/**
 * Resolved payment config: the non-secret provider_config joined with the
 * decrypted secret (retrieved via `fn_get_community_payment_secret`).
 */
export type PaymentProviderConfig = {
  provider: "pesapal";
  config: PesapalConfig;
  /** Pesapal consumer_secret, freshly decrypted per-request. */
  secret: string;
};

/** Context the route assembles for a given line-item payment-link request. */
export interface GeneratePaymentLinkContext {
  lineItemId: string;
  /** Unique-per-call merchant reference (e.g. "INV-<id>-<ts>"). */
  orderId: string;
  amount: number;
  description: string;
  billingAddress: BillingAddress;
  callbackUrl: string;
  /** ISO currency code from the microgrid's configured `currency`. */
  currency: string;
}

/** Result returned by a provider's `generatePaymentLink`. */
export interface GeneratePaymentLinkResult {
  /**
   * Hosted-checkout URL the user is redirected to. Contains a short-lived
   * session token — treat as sensitive; never log.
   */
  redirectUrl: string;
  /** Provider's canonical order id (Pesapal `order_tracking_id`). */
  providerOrderId: string;
  /** Merchant reference echoed back (the orderId we supplied). */
  providerReference: string;
}

/**
 * Every provider class implements this interface. Provider-specific errors
 * (subclasses of `PaymentError`) are allowed to propagate — the route handler
 * catches `PaymentError` and maps codes to HTTP responses.
 */
export interface PaymentProviderClient {
  generatePaymentLink(
    context: GeneratePaymentLinkContext,
  ): Promise<GeneratePaymentLinkResult>;
}
