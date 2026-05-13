import { describe, it, expect } from "vitest";
import { calculateTieredCost } from "../calculations";
import type { TierConfig } from "@/lib/types/domain";

// Seed tiers matching the real-world Uganda pricing structure
const seedTiers: TierConfig[] = [
  { label: "Tier 1", min_kwh: 1, max_kwh: 15, rate_per_kwh: 250 },
  { label: "Tier 2", min_kwh: 16, max_kwh: 80, rate_per_kwh: 756.2 },
  { label: "Tier 3", min_kwh: 81, max_kwh: 150, rate_per_kwh: 412 },
  { label: "Tier 4", min_kwh: 151, max_kwh: null, rate_per_kwh: 756.2 },
];

const SERVICE_CHARGE = 5320;
const TAX_RATE = 0.18;

describe("calculateTieredCost", () => {
  it("should handle usage spanning all 4 tiers (200 kWh)", () => {
    const result = calculateTieredCost(200, seedTiers, SERVICE_CHARGE, TAX_RATE);

    // Tier 1: 15 kWh (capacity: 15-1+1=15), Tier 2: 65 kWh (80-16+1=65),
    // Tier 3: 70 kWh (150-81+1=70), Tier 4: 50 kWh (remaining)
    expect(result.tierBreakdown).toHaveLength(4);
    // #227: tier-level amounts are now rounded to integer at write time.
    expect(result.tierBreakdown[0]).toEqual({ label: "Tier 1", kwh: 15, amount: 15 * 250 });
    expect(result.tierBreakdown[1]).toEqual({ label: "Tier 2", kwh: 65, amount: Math.round(65 * 756.2) });
    expect(result.tierBreakdown[2]).toEqual({ label: "Tier 3", kwh: 70, amount: 70 * 412 });
    expect(result.tierBreakdown[3]).toEqual({ label: "Tier 4", kwh: 50, amount: Math.round(50 * 756.2) });

    // #227: subtotal/netAmount/taxAmount/totalAmount are integer.
    const expectedSubtotal =
      15 * 250 + Math.round(65 * 756.2) + 70 * 412 + Math.round(50 * 756.2);
    expect(result.subtotal).toBe(expectedSubtotal);
    expect(result.serviceCharge).toBe(SERVICE_CHARGE);
    expect(result.netAmount).toBe(expectedSubtotal + SERVICE_CHARGE);
    expect(result.taxAmount).toBe(
      Math.round((expectedSubtotal + SERVICE_CHARGE) * TAX_RATE)
    );
    expect(result.totalAmount).toBe(
      result.netAmount + result.taxAmount
    );

    // Integer-shape invariant.
    expect(Number.isInteger(result.subtotal)).toBe(true);
    expect(Number.isInteger(result.netAmount)).toBe(true);
    expect(Number.isInteger(result.taxAmount)).toBe(true);
    expect(Number.isInteger(result.totalAmount)).toBe(true);
  });

  it("should handle usage fitting in first tier only (10 kWh)", () => {
    const result = calculateTieredCost(10, seedTiers, SERVICE_CHARGE, TAX_RATE);

    expect(result.tierBreakdown).toHaveLength(1);
    expect(result.tierBreakdown[0]).toEqual({ label: "Tier 1", kwh: 10, amount: 10 * 250 });

    const expectedSubtotal = 10 * 250;
    expect(result.subtotal).toBe(expectedSubtotal);
    expect(result.netAmount).toBe(expectedSubtotal + SERVICE_CHARGE);
  });

  it("should handle usage exactly on tier boundary (15 kWh)", () => {
    const result = calculateTieredCost(15, seedTiers, SERVICE_CHARGE, TAX_RATE);

    expect(result.tierBreakdown).toHaveLength(1);
    expect(result.tierBreakdown[0]).toEqual({ label: "Tier 1", kwh: 15, amount: 15 * 250 });
  });

  it("should apply service charge and tax even with zero usage", () => {
    const result = calculateTieredCost(0, seedTiers, SERVICE_CHARGE, TAX_RATE);

    expect(result.tierBreakdown).toHaveLength(0);
    expect(result.subtotal).toBe(0);
    expect(result.serviceCharge).toBe(SERVICE_CHARGE);
    expect(result.netAmount).toBe(SERVICE_CHARGE);
    expect(result.taxAmount).toBe(Math.round(SERVICE_CHARGE * TAX_RATE));
    expect(result.totalAmount).toBe(
      result.netAmount + result.taxAmount
    );
  });

  it("should handle fractional kWh (15.5 kWh)", () => {
    const result = calculateTieredCost(15.5, seedTiers, SERVICE_CHARGE, TAX_RATE);

    // Tier 1 capacity = 15, so 15 kWh in tier 1, 0.5 kWh in tier 2
    expect(result.tierBreakdown).toHaveLength(2);
    expect(result.tierBreakdown[0]).toEqual({ label: "Tier 1", kwh: 15, amount: 15 * 250 });
    // #227: tier amount rounds to integer (0.5 * 756.2 = 378.1 → 378).
    expect(result.tierBreakdown[1]).toEqual({
      label: "Tier 2",
      kwh: 0.5,
      amount: Math.round(0.5 * 756.2),
    });
  });

  it("should handle a single unbounded tier", () => {
    const singleTier: TierConfig[] = [
      { label: "Flat Rate", min_kwh: 1, max_kwh: null, rate_per_kwh: 500 },
    ];
    const result = calculateTieredCost(100, singleTier, 1000, 0.1);

    expect(result.tierBreakdown).toHaveLength(1);
    expect(result.tierBreakdown[0]).toEqual({ label: "Flat Rate", kwh: 100, amount: 50000 });
    expect(result.subtotal).toBe(50000);
    expect(result.netAmount).toBe(51000);
    expect(result.taxAmount).toBe(5100);
    expect(result.totalAmount).toBe(56100);
  });

  it("should handle empty tiers array", () => {
    const result = calculateTieredCost(100, [], SERVICE_CHARGE, TAX_RATE);

    expect(result.tierBreakdown).toHaveLength(0);
    expect(result.subtotal).toBe(0);
    expect(result.netAmount).toBe(SERVICE_CHARGE);
    expect(result.totalAmount).toBe(
      SERVICE_CHARGE + Math.round(SERVICE_CHARGE * TAX_RATE)
    );
  });

  it("should handle 6 tiers (N-tier support)", () => {
    const sixTiers: TierConfig[] = [
      { label: "Tier 1", min_kwh: 1, max_kwh: 10, rate_per_kwh: 100 },
      { label: "Tier 2", min_kwh: 11, max_kwh: 20, rate_per_kwh: 200 },
      { label: "Tier 3", min_kwh: 21, max_kwh: 30, rate_per_kwh: 300 },
      { label: "Tier 4", min_kwh: 31, max_kwh: 40, rate_per_kwh: 400 },
      { label: "Tier 5", min_kwh: 41, max_kwh: 50, rate_per_kwh: 500 },
      { label: "Tier 6", min_kwh: 51, max_kwh: null, rate_per_kwh: 600 },
    ];

    const result = calculateTieredCost(55, sixTiers, 0, 0);

    expect(result.tierBreakdown).toHaveLength(6);
    expect(result.tierBreakdown[0]).toEqual({ label: "Tier 1", kwh: 10, amount: 1000 });
    expect(result.tierBreakdown[1]).toEqual({ label: "Tier 2", kwh: 10, amount: 2000 });
    expect(result.tierBreakdown[2]).toEqual({ label: "Tier 3", kwh: 10, amount: 3000 });
    expect(result.tierBreakdown[3]).toEqual({ label: "Tier 4", kwh: 10, amount: 4000 });
    expect(result.tierBreakdown[4]).toEqual({ label: "Tier 5", kwh: 10, amount: 5000 });
    expect(result.tierBreakdown[5]).toEqual({ label: "Tier 6", kwh: 5, amount: 3000 });

    expect(result.subtotal).toBe(18000);
    expect(result.totalAmount).toBe(18000);
  });

  it("should handle large usage (10000 kWh)", () => {
    const result = calculateTieredCost(10000, seedTiers, SERVICE_CHARGE, TAX_RATE);

    // Tier 1: 15, Tier 2: 65, Tier 3: 70, Tier 4: 9850
    expect(result.tierBreakdown).toHaveLength(4);
    expect(result.tierBreakdown[0].kwh).toBe(15);
    expect(result.tierBreakdown[1].kwh).toBe(65);
    expect(result.tierBreakdown[2].kwh).toBe(70);
    expect(result.tierBreakdown[3].kwh).toBe(9850);

    // Integer-shape invariant for large-input case.
    expect(Number.isInteger(result.subtotal)).toBe(true);
    expect(Number.isInteger(result.totalAmount)).toBe(true);
  });

  // ── #227 dust regression ────────────────────────────────────────────────────
  // The Peter Ntale fixture: usage of 178.3500000000002 (IEEE-754 dust from
  // `261.92 - 83.570`) must produce rounded tier values and integer totals.
  it("rounds IEEE-754 dust on usageKwh input (178.3500000000002 fixture, #227)", () => {
    const result = calculateTieredCost(
      178.3500000000002,
      seedTiers,
      SERVICE_CHARGE,
      TAX_RATE
    );

    // Tier 1: 15 (cap), Tier 2: 65 (cap), Tier 3: 70 (cap),
    // Tier 4: 178.35 - 150 = 28.35.
    expect(result.tierBreakdown).toHaveLength(4);
    expect(result.tierBreakdown[3].kwh).toBe(28.35);
    // × 1000 == 28350 defeats numeric vacuity (28.35 === 28.350 in JS).
    expect(result.tierBreakdown[3].kwh * 1000).toBe(28350);

    // Every tier amount is integer.
    for (const t of result.tierBreakdown) {
      expect(Number.isInteger(t.amount)).toBe(true);
    }
    expect(Number.isInteger(result.subtotal)).toBe(true);
    expect(Number.isInteger(result.totalAmount)).toBe(true);
  });
});
