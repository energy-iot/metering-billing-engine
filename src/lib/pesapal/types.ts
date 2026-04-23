/**
 * Pesapal API 3.0 — shared types.
 * Mirrors pesapal_api_functions.py (Python reference implementation).
 */

/**
 * Pesapal billing_address payload.
 * Either email_address or phone_number is required; all other fields optional.
 * Phone numbers must include country code (e.g. "+256...").
 */
export interface BillingAddress {
  email_address?: string;
  phone_number?: string;
  first_name?: string;
  last_name?: string;
  middle_name?: string;
  country_code?: string; // ISO 3166-1 alpha-2, e.g. "UG", "KE"
  line_1?: string;
  line_2?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  zip_code?: string;
}

/** Response from /api/Auth/RequestToken */
export interface AuthTokenResponse {
  token: string;
  expiryDate: string;
  error?: unknown;
  status?: string;
  message?: string;
}

/** Single entry from /api/URLSetup/GetIpnList */
export interface IpnEntry {
  url: string;
  created_date: string;
  ipn_id: string;
  notification_type: number;
  ipn_notification_type_description?: string;
  ipn_status?: number;
  ipn_status_description?: string;
}

/** Params to submitOrder — camelCase on the TS side, mapped to snake_case on the wire. */
export interface SubmitOrderParams {
  token: string;
  id: string;
  amount: number;
  description: string;
  callbackUrl: string;
  notificationId: string;
  billingAddress: BillingAddress;
  /** ISO currency code. Defaults to "UGX" when omitted. */
  currency?: string;
}

/** Response from /api/Transactions/SubmitOrderRequest */
export interface SubmitOrderResponse {
  order_tracking_id?: string;
  merchant_reference?: string;
  redirect_url?: string;
  status?: string;
  error?: unknown;
}

/** Params for the composite createPaymentOrder — omits token/notificationId (handled internally). */
export interface CreatePaymentOrderParams {
  id: string;
  amount: number;
  description: string;
  callbackUrl: string;
  billingAddress: BillingAddress;
  /** ISO currency code. Defaults to "UGX". */
  currency?: string;
  /** Which registered IPN to use, by index. Defaults to 0 (first). */
  ipnIndex?: number;
}
