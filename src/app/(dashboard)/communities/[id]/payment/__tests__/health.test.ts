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

  it("returns stale for save >= 24h ago", () => {
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
    ).toBe("stale");
  });

  it("returns stale when payment_provider set but payment_last_configured_at is null (defensive)", () => {
    expect(
      derivePaymentHealth(
        {
          payment_provider: "pesapal",
          payment_last_configured_at: null,
        },
        NOW,
      ),
    ).toBe("stale");
  });

  it("never returns failing today — reserved for #121", () => {
    // Exercise a range of inputs and assert the helper NEVER emits "failing".
    const inputs = [
      { payment_provider: null, payment_last_configured_at: null },
      {
        payment_provider: "pesapal" as const,
        payment_last_configured_at: new Date().toISOString(),
      },
      {
        payment_provider: "pesapal" as const,
        payment_last_configured_at: new Date(
          NOW.getTime() - 365 * 24 * 3600 * 1000,
        ).toISOString(),
      },
      {
        payment_provider: "pesapal" as const,
        payment_last_configured_at: "not-a-date",
      },
    ];
    for (const row of inputs) {
      expect(derivePaymentHealth(row, NOW)).not.toBe("failing");
    }
  });
});
