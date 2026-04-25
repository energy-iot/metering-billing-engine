import { PaymentError } from "../errors";

/**
 * Pesapal-specific errors. Extends `PaymentError` so the route handler only
 * needs a single `instanceof PaymentError` check to catch both generic config
 * issues (NOT_CONFIGURED, FORBIDDEN) and provider-specific failures.
 *
 * Pesapal codes are mapped to short `reason` strings in the route handler —
 * the `code` is logged for debugging but never exposed in the HTTP response
 * body.
 */
export class PesapalError extends PaymentError {
  constructor(
    message: string,
    code: string,
    statusCode: number = 500,
    details?: unknown,
  ) {
    super(message, code, statusCode, details);
    this.name = "PesapalError";
  }
}

// Error codes:
// "PESAPAL_INVALID_CONFIG"        (503) — config missing consumer_key / secret / base_url
// "PESAPAL_AUTH_FAILED"           (401) — auth token request failed
// "PESAPAL_HTTP_ERROR"            (502) — non-2xx from Pesapal
// "PESAPAL_NO_IPN"                (400) — no IPN registrations on the account
//                                          (legacy; post-#121 parsePesapalConfig
//                                          rejects upstream with PAYMENT_INVALID_CONFIG)
// "PESAPAL_REGISTER_IPN_FAILED"   (502) — RegisterIPN endpoint failed or returned no ipn_id
// "PESAPAL_UNREACHABLE"           (503) — network/fetch failure
// "PESAPAL_MISSING_CONTACT"       (400) — household has neither email nor phone
// "PESAPAL_ZERO_AMOUNT"           (400) — line item total is <= 0
// "PESAPAL_LINE_ITEM_NOT_FOUND"   (404) — line item lookup returned no row
// "PESAPAL_PERIOD_NOT_FOUND"      (404) — billing_periods join returned no row
// "PESAPAL_HOUSEHOLD_NOT_FOUND"   (404) — household lookup returned no row
// "PESAPAL_NO_REDIRECT"           (502) — submit order succeeded but redirect_url missing
