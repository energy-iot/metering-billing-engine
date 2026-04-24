/**
 * payments/ — multi-provider payment adapter.
 *
 * Mirrors the structure of `src/lib/openems/`. Consumers import from this
 * barrel to get the generic surface; provider-specific errors / classes
 * (e.g. `PesapalProvider`) are not re-exported here — routes catch the
 * generic `PaymentError` and map `code` → HTTP reason.
 */

export { PaymentError } from "./errors";
export { getPaymentProviderClient } from "./factory";
export type {
  PaymentProvider,
  PaymentProviderConfig,
  PaymentProviderClient,
  GeneratePaymentLinkContext,
  GeneratePaymentLinkResult,
} from "./types";
