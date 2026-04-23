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
    expect(result.tierBreakdown[0]).toEqual({ label: "Tier 1", kwh: 15, amount: 15 * 250 });
    expect(result.tierBreakdown[1]).toEqual({ label: "Tier 2", kwh: 65, amount: 65 * 756.2 });
    expect(result.tierBreakdown[2]).toEqual({ label: "Tier 3", kwh: 70, amount: 70 * 412 });
    expect(result.tierBreakdown[3]).toEqual({ label: "Tier 4", kwh: 50, amount: 50 * 756.2 });

    const expectedSubtotal = 15 * 250 + 65 * 756.2 + 70 * 412 + 50 * 756.2;
    expect(result.subtotal).toBeCloseTo(expectedSubtotal);
    expect(result.serviceCharge).toBe(SERVICE_CHARGE);
    expect(result.netAmount).toBeCloseTo(expectedSubtotal + SERVICE_CHARGE);
    expect(result.taxAmount).toBeCloseTo((expectedSubtotal + SERVICE_CHARGE) * TAX_RATE);
    expect(result.totalAmount).toBeCloseTo(
      (expectedSubtotal + SERVICE_CHARGE) * (1 + TAX_RATE)
    );
  });

  it("should handle usage fitting in first tier only (10 kWh)", () => {
    const result = calculateTieredCost(10, seedTiers, SERVICE_CHARGE, TAX_RATE);

    expect(result.tierBreakdown).toHaveLength(1);
    expect(result.tierBreakdown[0]).toEqual({ label: "Tier 1", kwh: 10, amount: 10 * 250 });

    const expectedSubtotal = 10 * 250;
    expect(result.subtotal).toBeCloseTo(expectedSubtotal);
    expect(result.netAmount).toBeCloseTo(expectedSubtotal + SERVICE_CHARGE);
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
    expect(result.taxAmount).toBeCloseTo(SERVICE_CHARGE * TAX_RATE);
    expect(result.totalAmount).toBeCloseTo(SERVICE_CHARGE * (1 + TAX_RATE));
  });

  it("should handle fractional kWh (15.5 kWh)", () => {
    const result = calculateTieredCost(15.5, seedTiers, SERVICE_CHARGE, TAX_RATE);

    // Tier 1 capacity = 15, so 15 kWh in tier 1, 0.5 kWh in tier 2
    expect(result.tierBreakdown).toHaveLength(2);
    expect(result.tierBreakdown[0]).toEqual({ label: "Tier 1", kwh: 15, amount: 15 * 250 });
    expect(result.tierBreakdown[1]).toEqual({ label: "Tier 2", kwh: 0.5, amount: 0.5 * 756.2 });
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
    expect(result.taxAmount).toBeCloseTo(5100);
    expect(result.totalAmount).toBeCloseTo(56100);
  });

  it("should handle empty tiers array", () => {
    const result = calculateTieredCost(100, [], SERVICE_CHARGE, TAX_RATE);

    expect(result.tierBreakdown).toHaveLength(0);
    expect(result.subtotal).toBe(0);
    expect(result.netAmount).toBe(SERVICE_CHARGE);
    expect(result.totalAmount).toBeCloseTo(SERVICE_CHARGE * (1 + TAX_RATE));
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

    const expectedSubtotal =
      15 * 250 + 65 * 756.2 + 70 * 412 + 9850 * 756.2;
    expect(result.subtotal).toBeCloseTo(expectedSubtotal);
    expect(result.totalAmount).toBeCloseTo(
      (expectedSubtotal + SERVICE_CHARGE) * (1 + TAX_RATE)
    );
  });
});
