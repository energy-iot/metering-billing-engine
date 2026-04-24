import type {
  PaymentProviderClient,
  PaymentProviderConfig,
} from "./types";
import { PaymentError } from "./errors";
import { PesapalProvider } from "./pesapal";

/**
 * getPaymentProviderClient — dispatch on the `provider` discriminator and
 * return a ready-to-use `PaymentProviderClient`.
 *
 * Exhaustiveness is enforced by the `never` assignment in the default branch —
 * adding a new value to `PaymentProvider` without updating this switch will
 * fail the build.
 */
export function getPaymentProviderClient(
  config: PaymentProviderConfig,
): PaymentProviderClient {
  // Pull the discriminator into a local so the exhaustiveness guard below
  // narrows to `never` correctly even when `PaymentProviderConfig` has only a
  // single branch (in which case `config` would narrow to `never` in the
  // default arm and the `never` guard variable assignment would fail TS).
  const provider: PaymentProviderConfig["provider"] = config.provider;

  switch (provider) {
    case "pesapal":
      return new PesapalProvider({
        config: config.config,
        secret: config.secret,
      });
    default: {
      // Exhaustiveness guard: if a new value is added to `PaymentProvider`
      // without a case above, TypeScript errors on this `never` assignment.
      // The thrown error also covers the runtime case of an unchecked cast
      // slipping a bad discriminator through.
      const _exhaustive: never = provider;
      throw new PaymentError(
        `Unknown payment provider: ${String(_exhaustive)}`,
        "PAYMENT_UNKNOWN_PROVIDER",
        500,
      );
    }
  }
}
