import { PesapalClient } from "./client";
import { PesapalError } from "./errors";
import type {
  GeneratePaymentLinkContext,
  GeneratePaymentLinkResult,
  PaymentProviderClient,
} from "../types";
import type { PesapalConfig } from "./types";

/**
 * PesapalProvider — `PaymentProviderClient` implementation for Pesapal.
 *
 * `generatePaymentLink` performs the composite three-step flow:
 *   1. getAccessToken → Bearer token (Step 1 of Pesapal 3.0 flow)
 *   2. submitOrder with the configured IPN id (Step 3 — IPN is pre-registered
 *      at configure-time and stored on `communities.payment_provider_config`;
 *      Step 2 `GetIpnList` is skipped since the IPN is known)
 *
 * Each call performs two HTTP requests against Pesapal; caching the token is
 * a future optimization and out of scope here.
 */
export class PesapalProvider implements PaymentProviderClient {
  private readonly client: PesapalClient;
  private readonly ipnId: string;

  constructor(cfg: { config: PesapalConfig; secret: string }) {
    if (!cfg.config.ipn_id || !cfg.config.ipn_id.trim()) {
      throw new PesapalError(
        "Pesapal config missing ipn_id — register an IPN via Pesapal first",
        "PESAPAL_NO_IPN",
        400,
      );
    }
    this.ipnId = cfg.config.ipn_id;
    this.client = new PesapalClient({
      consumerKey: cfg.config.consumer_key,
      consumerSecret: cfg.secret,
      baseUrl: cfg.config.base_url,
    });
  }

  async generatePaymentLink(
    context: GeneratePaymentLinkContext,
  ): Promise<GeneratePaymentLinkResult> {
    const token = await this.client.getAccessToken();

    const response = await this.client.submitOrder({
      token,
      id: context.orderId,
      amount: context.amount,
      description: context.description,
      callbackUrl: context.callbackUrl,
      notificationId: this.ipnId,
      billingAddress: context.billingAddress,
      currency: context.currency,
    });

    if (!response.redirect_url) {
      throw new PesapalError(
        "Pesapal submitOrder did not return a redirect_url",
        "PESAPAL_NO_REDIRECT",
        502,
        response,
      );
    }

    return {
      redirectUrl: response.redirect_url,
      providerOrderId: response.order_tracking_id ?? "",
      providerReference: response.merchant_reference ?? context.orderId,
    };
  }
}
