/**
 * Tests for getPaymentProviderClient dispatch + exhaustiveness.
 *
 * Mirrors `src/lib/openems/__tests__/factory.test.ts` style — unit-level,
 * no network, asserts on the returned class shape and the thrown error for
 * unknown discriminators.
 */

import { describe, it, expect } from "vitest";
import { getPaymentProviderClient, PaymentError } from "..";
import type { PaymentProviderConfig } from "..";
import { PesapalProvider } from "../pesapal";

describe("getPaymentProviderClient(config)", () => {
  it("returns a PesapalProvider for provider='pesapal'", () => {
    const config: PaymentProviderConfig = {
      provider: "pesapal",
      config: {
        consumer_key: "ck_live",
        base_url: "https://pay.pesapal.com/v3",
        ipn_id: "ipn-123",
      },
      secret: "cs_live_verylongsecret",
    };

    const client = getPaymentProviderClient(config);
    expect(client).toBeInstanceOf(PesapalProvider);
  });

  it("throws PaymentError('PAYMENT_UNKNOWN_PROVIDER') for an unrecognized provider", () => {
    // Simulate a post-migration case where a new enum value (e.g. 'stripe')
    // landed in the DB but the factory wasn't updated. Cast through unknown.
    const bogusConfig = {
      provider: "stripe",
      config: {},
      secret: "ignored",
    } as unknown as PaymentProviderConfig;

    expect(() => getPaymentProviderClient(bogusConfig)).toThrow(PaymentError);
    expect(() => getPaymentProviderClient(bogusConfig)).toThrow(
      expect.objectContaining({
        code: "PAYMENT_UNKNOWN_PROVIDER",
        statusCode: 500,
      }),
    );
  });
});
