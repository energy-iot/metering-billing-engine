import { PesapalError } from "./errors";
import type {
  AuthTokenResponse,
  CreatePaymentOrderParams,
  IpnEntry,
  SubmitOrderParams,
  SubmitOrderResponse,
} from "./types";

// Production base URL. Swap to https://cybqa.pesapal.com/pesapalv3 for sandbox.
const BASE_URL = process.env.PESAPAL_BASE_URL ?? "https://pay.pesapal.com/v3";

/**
 * Thin JSON fetch wrapper that surfaces non-2xx responses as PesapalErrors
 * with the upstream body attached for debugging.
 */
async function pesapalFetch<T>(
  path: string,
  init: RequestInit,
  errorCode: string,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
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

// ---------------------------------------------------------------------------
// Step 1: Request access token
// ---------------------------------------------------------------------------

export async function getAccessToken(): Promise<string> {
  const consumerKey = process.env.PESAPAL_CONSUMER_KEY;
  const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET;
  if (!consumerKey || !consumerSecret) {
    throw new PesapalError(
      "PESAPAL_CONSUMER_KEY and PESAPAL_CONSUMER_SECRET must be set",
      "PESAPAL_INVALID_CONFIG",
      503,
    );
  }

  const data = await pesapalFetch<AuthTokenResponse>(
    "/api/Auth/RequestToken",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        consumer_key: consumerKey,
        consumer_secret: consumerSecret,
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

// ---------------------------------------------------------------------------
// Step 2: Get all registered IPN URLs
// ---------------------------------------------------------------------------

export async function getAllIpn(token: string): Promise<IpnEntry[]> {
  return pesapalFetch<IpnEntry[]>(
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

// ---------------------------------------------------------------------------
// Step 3: Submit order request
// ---------------------------------------------------------------------------

export async function submitOrder({
  token,
  id,
  amount,
  description,
  callbackUrl,
  notificationId,
  billingAddress,
  currency = "UGX",
}: SubmitOrderParams): Promise<SubmitOrderResponse> {
  return pesapalFetch<SubmitOrderResponse>(
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

// ---------------------------------------------------------------------------
// Step 4: Composite — one call, get a redirect URL
// ---------------------------------------------------------------------------

/**
 * End-to-end: authenticate → pick an IPN → submit the order.
 * Suitable for the "Get Billing URL" click-to-generate flow.
 * Each call performs three HTTP requests; caching token/IPN is a future optimization.
 */
export async function createPaymentOrder({
  id,
  amount,
  description,
  callbackUrl,
  billingAddress,
  currency = "UGX",
  ipnIndex = 0,
}: CreatePaymentOrderParams): Promise<SubmitOrderResponse> {
  const token = await getAccessToken();
  const ipnList = await getAllIpn(token);
  if (ipnList.length === 0) {
    throw new PesapalError(
      "No IPNs registered in this Pesapal account. Register one via /api/URLSetup/RegisterIPN before submitting orders.",
      "PESAPAL_NO_IPN",
      400,
    );
  }
  const ipn = ipnList[ipnIndex];
  if (!ipn) {
    throw new PesapalError(
      `ipnIndex ${ipnIndex} out of range (only ${ipnList.length} IPN(s) registered)`,
      "PESAPAL_NO_IPN",
      400,
    );
  }
  return submitOrder({
    token,
    id,
    amount,
    description,
    callbackUrl,
    notificationId: ipn.ipn_id,
    billingAddress,
    currency,
  });
}
