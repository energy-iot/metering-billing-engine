/**
 * parsePesapalConfig unit tests (#121).
 *
 * Pins the post-#121 contract:
 *   - `consumer_key`, `base_url`, `ipn_id` are all REQUIRED.
 *   - Missing `ipn_id` throws `PAYMENT_IPN_NOT_REGISTERED` (distinct from
 *     generic `PAYMENT_INVALID_CONFIG`) so route handlers can map it to a
 *     409 `ipn_not_registered` with an actionable hint.
 *   - `sandbox` round-trips through unchanged when supplied.
 */

import { describe, it, expect } from "vitest";
import { parsePesapalConfig } from "../config";
import { PaymentError } from "../errors";

describe("parsePesapalConfig", () => {
  it("accepts a fully-populated config and round-trips fields", () => {
    const cfg = parsePesapalConfig({
      consumer_key: "ck_live",
      base_url: "https://pay.pesapal.com/v3",
      ipn_id: "ipn-abc",
      sandbox: false,
    });
    expect(cfg).toEqual({
      consumer_key: "ck_live",
      base_url: "https://pay.pesapal.com/v3",
      ipn_id: "ipn-abc",
      sandbox: false,
    });
  });

  it("rejects null/undefined / non-object input", () => {
    expect(() => parsePesapalConfig(null)).toThrow(PaymentError);
    expect(() => parsePesapalConfig(undefined)).toThrow(PaymentError);
    expect(() => parsePesapalConfig("string")).toThrow(PaymentError);
  });

  it("rejects config missing consumer_key with PAYMENT_INVALID_CONFIG", () => {
    try {
      parsePesapalConfig({
        base_url: "https://pay.pesapal.com/v3",
        ipn_id: "ipn-abc",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      expect((err as PaymentError).code).toBe("PAYMENT_INVALID_CONFIG");
    }
  });

  it("rejects config missing ipn_id with PAYMENT_IPN_NOT_REGISTERED (409)", () => {
    try {
      parsePesapalConfig({
        consumer_key: "ck_live",
        base_url: "https://pay.pesapal.com/v3",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      const pe = err as PaymentError;
      expect(pe.code).toBe("PAYMENT_IPN_NOT_REGISTERED");
      expect(pe.statusCode).toBe(409);
      expect(pe.message).toMatch(/Save & test/i);
    }
  });

  it("rejects config with empty-string ipn_id (after trim)", () => {
    try {
      parsePesapalConfig({
        consumer_key: "ck_live",
        base_url: "https://pay.pesapal.com/v3",
        ipn_id: "   ",
      });
      throw new Error("expected to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentError);
      expect((err as PaymentError).code).toBe("PAYMENT_IPN_NOT_REGISTERED");
    }
  });
});
