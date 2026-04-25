import { PesapalError } from "./errors";
import type {
  AuthTokenResponse,
  IpnEntry,
  RegisterIpnResponse,
  SubmitOrderParams,
  SubmitOrderResponse,
} from "./types";

/** Pesapal supports POST or GET for IPN delivery. We default to POST. */
export type IpnNotificationType = "POST" | "GET";

/**
 * Pesapal client (stateless).
 *
 * Adapted from PR #58's `src/lib/pesapal/client.ts`. The major change vs. PR
 * #58: the client no longer reads `process.env.PESAPAL_*`. All credentials
 * (consumer_key, consumer_secret) and the base URL are injected via the
 * constructor. Every call site resolves config from the
 * `communities.payment_provider_config` + `fn_get_community_payment_secret`
 * path — there is no global fallback.
 */
export interface PesapalClientConfig {
  consumerKey: string;
  consumerSecret: string;
  baseUrl: string;
}

export class PesapalClient {
  constructor(private readonly config: PesapalClientConfig) {
    if (
      !config.consumerKey ||
      !config.consumerSecret ||
      !config.baseUrl ||
      !config.baseUrl.trim()
    ) {
      throw new PesapalError(
        "Pesapal config missing consumer_key / consumer_secret / base_url",
        "PESAPAL_INVALID_CONFIG",
        503,
      );
    }
  }

  /**
   * Thin JSON fetch wrapper that surfaces non-2xx responses as PesapalErrors
   * with the upstream body attached for debugging. Network failures surface
   * as PESAPAL_UNREACHABLE; non-2xx responses as the caller-supplied
   * errorCode.
   */
  private async pesapalFetch<T>(
    path: string,
    init: RequestInit,
    errorCode: string,
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl}${path}`, init);
    } catch (cause) {
      throw new PesapalError(
        `Pesapal request failed: ${String(cause)}`,
        "PESAPAL_UNREACHABLE",
        503,
        cause,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new PesapalError(
        `Pesapal ${path} returned ${res.status}: ${body.slice(0, 500)}`,
        errorCode,
        502,
        { status: res.status, body },
      );
    }
    return (await res.json()) as T;
  }

  /** Step 1: Request access token. */
  async getAccessToken(): Promise<string> {
    const data = await this.pesapalFetch<AuthTokenResponse>(
      "/api/Auth/RequestToken",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          consumer_key: this.config.consumerKey,
          consumer_secret: this.config.consumerSecret,
        }),
      },
      "PESAPAL_AUTH_FAILED",
    );

    if (!data.token) {
      throw new PesapalError(
        `Pesapal auth returned no token: ${data.message ?? JSON.stringify(data)}`,
        "PESAPAL_AUTH_FAILED",
        401,
        data,
      );
    }
    return data.token;
  }

  /** Step 2: Get all registered IPN URLs. */
  async getAllIpn(token: string): Promise<IpnEntry[]> {
    return this.pesapalFetch<IpnEntry[]>(
      "/api/URLSetup/GetIpnList",
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
      },
      "PESAPAL_HTTP_ERROR",
    );
  }

  /**
   * Register an IPN URL with Pesapal and return the canonical record (incl.
   * `ipn_id`). Called by the Save & test flow (#121) so subsequent
   * `submitOrder` calls can pass `notification_id`.
   *
   * Pesapal returns 200 with `{ ipn_id: "<GUID>", ... }` on success. Any 2xx
   * payload missing `ipn_id` surfaces as `PESAPAL_REGISTER_IPN_FAILED`.
   * Non-2xx and network failures surface via `pesapalFetch` as
   * `PESAPAL_REGISTER_IPN_FAILED` and `PESAPAL_UNREACHABLE` respectively.
   */
  async registerIpn(
    token: string,
    url: string,
    type: IpnNotificationType = "POST",
  ): Promise<RegisterIpnResponse> {
    const data = await this.pesapalFetch<RegisterIpnResponse>(
      "/api/URLSetup/RegisterIPN",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          url,
          ipn_notification_type: type,
        }),
      },
      "PESAPAL_REGISTER_IPN_FAILED",
    );

    if (!data.ipn_id || !String(data.ipn_id).trim()) {
      throw new PesapalError(
        `Pesapal RegisterIPN returned no ipn_id: ${JSON.stringify(data).slice(0, 500)}`,
        "PESAPAL_REGISTER_IPN_FAILED",
        502,
        data,
      );
    }
    return data;
  }

  /** Step 3: Submit order request. */
  async submitOrder({
    token,
    id,
    amount,
    description,
    callbackUrl,
    notificationId,
    billingAddress,
    currency = "UGX",
  }: SubmitOrderParams): Promise<SubmitOrderResponse> {
    return this.pesapalFetch<SubmitOrderResponse>(
      "/api/Transactions/SubmitOrderRequest",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          id,
          currency,
          amount,
          description,
          callback_url: callbackUrl,
          notification_id: notificationId,
          billing_address: billingAddress,
        }),
      },
      "PESAPAL_HTTP_ERROR",
    );
  }
}
