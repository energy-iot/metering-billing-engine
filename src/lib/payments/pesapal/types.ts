/**
 * Pesapal API 3.0 — shared wire-shape types.
 * Mirrors pesapal_api_functions.py (upstream Python reference).
 *
 * Lifted verbatim from PR #58 (`src/lib/pesapal/types.ts` by @rhussain21).
 * No schema changes — these describe Pesapal's HTTP surface.
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

/**
 * Response from /api/URLSetup/RegisterIPN.
 *
 * Pesapal returns the canonical record for the registered IPN, including the
 * `ipn_id` GUID which we persist on `communities.payment_provider_config` and
 * pass back into `submitOrder` as `notification_id`.
 */
export interface RegisterIpnResponse {
  url: string;
  created_date: string;
  ipn_id: string;
  notification_type?: number | string;
  ipn_notification_type_description?: string;
  ipn_status?: number;
  ipn_status_description?: string;
  status?: string;
  error?: unknown;
}

/**
 * Non-secret Pesapal config stored as JSONB in
 * `communities.payment_provider_config`. `consumer_secret` is stored separately
 * in `payment_provider_secret_encrypted` (envelope-encrypted BYTEA) and
 * surfaced via `fn_get_community_payment_secret`.
 *
 * `ipn_id` is **required** post-#121: Save & test now registers an IPN with
 * Pesapal as part of the success path and writes the returned GUID here. A
 * persisted Pesapal config without `ipn_id` is treated as malformed by
 * `parsePesapalConfig` (throws `PAYMENT_INVALID_CONFIG`).
 */
export interface PesapalConfig {
  consumer_key: string;
  base_url: string;
  ipn_id: string;
  /**
   * Persisted reflection of the Sandbox toggle in the config UI. Server
   * derives `base_url` from this boolean on write, but we also persist the
   * flag so the Reconfigure form can round-trip the toggle state without
   * string-matching the URL. Optional for backward compatibility with rows
   * written before #119 (there shouldn't be any in production, but tests
   * and fixtures may omit it).
   */
  sandbox?: boolean;
}
