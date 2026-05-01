import { describe, it, expect } from "vitest";
import { derivePaymentHealth } from "../health";

const NOW = new Date("2026-04-23T12:00:00Z");

describe("derivePaymentHealth()", () => {
  it("returns not_configured for null row", () => {
    expect(derivePaymentHealth(null, NOW)).toBe("not_configured");
  });

  it("returns not_configured when payment_provider is null", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: null,
          payment_last_configured_at: null,
        },
        NOW,
      ),
    ).toBe("not_configured");
  });

  it("returns healthy for save < 24h ago", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: new Date(
            NOW.getTime() - 2 * 3600 * 1000,
          ).toISOString(),
        },
        NOW,
      ),
    ).toBe("healthy");
  });

  it("returns healthy at the boundary (just under 24h)", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: new Date(
            NOW.getTime() - (24 * 3600 * 1000 - 1),
          ).toISOString(),
        },
        NOW,
      ),
    ).toBe("healthy");
  });

  it("returns healthy for save >= 24h ago (24h cliff removed)", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: new Date(
            NOW.getTime() - 48 * 3600 * 1000,
          ).toISOString(),
        },
        NOW,
      ),
    ).toBe("healthy");
  });

  it("returns healthy when payment_provider set but payment_last_configured_at is null (fail-open defensive case)", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: null,
        },
        NOW,
      ),
    ).toBe("healthy");
  });

  it("returns failing when a recent IPN failure happened in the last 24h (Phase B / #157)", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: new Date(
            NOW.getTime() - 2 * 3600 * 1000,
          ).toISOString(),
          most_recent_failed_ipn_at: new Date(
            NOW.getTime() - 1 * 3600 * 1000,
          ).toISOString(),
        },
        NOW,
      ),
    ).toBe("failing");
  });

  it("does NOT return failing when the failed IPN is older than 24h", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: new Date(
            NOW.getTime() - 1 * 3600 * 1000,
          ).toISOString(),
          most_recent_failed_ipn_at: new Date(
            NOW.getTime() - 48 * 3600 * 1000,
          ).toISOString(),
        },
        NOW,
      ),
    ).toBe("healthy");
  });

  it("ignores invalid most_recent_failed_ipn_at strings (no failing emitted)", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: new Date(
            NOW.getTime() - 1 * 3600 * 1000,
          ).toISOString(),
          most_recent_failed_ipn_at: "not-a-date",
        },
        NOW,
      ),
    ).toBe("healthy");
  });

  it("falls back to existing healthy logic when most_recent_failed_ipn_at is null", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: new Date(
            NOW.getTime() - 2 * 3600 * 1000,
          ).toISOString(),
          most_recent_failed_ipn_at: null,
        },
        NOW,
      ),
    ).toBe("healthy");
  });
});
