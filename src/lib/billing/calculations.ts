import type { TierConfig, TierBreakdown } from "@/lib/types/domain";

export type BillingCalculation = {
  tierBreakdown: TierBreakdown[];
  subtotal: number; // sum of tier amounts
  serviceCharge: number; // pass-through
  netAmount: number; // subtotal + serviceCharge
  taxAmount: number; // netAmount * taxRate
  totalAmount: number; // netAmount + taxAmount
};

export function calculateTieredCost(
  usageKwh: number,
  tiers: TierConfig[],
  serviceCharge: number,
  taxRate: number
): BillingCalculation {
  if (usageKwh <= 0 || tiers.length === 0) {
    const netAmount = serviceCharge;
    const taxAmount = netAmount * taxRate;
    return {
      tierBreakdown: [],
      subtotal: 0,
      serviceCharge,
      netAmount,
      taxAmount,
      totalAmount: netAmount + taxAmount,
    };
  }

  let remaining = usageKwh;
  const tierBreakdown: TierBreakdown[] = [];

  for (const tier of tiers) {
    if (remaining <= 0) break;

    const tierCapacity =
      tier.max_kwh !== null ? tier.max_kwh - tier.min_kwh + 1 : Infinity;
    const kwhInTier = Math.min(remaining, tierCapacity);
    const amount = kwhInTier * tier.rate_per_kwh;

    tierBreakdown.push({
      label: tier.label,
      kwh: kwhInTier,
      amount,
    });

    remaining -= kwhInTier;
  }

  const subtotal = tierBreakdown.reduce((sum, t) => sum + t.amount, 0);
  const netAmount = subtotal + serviceCharge;
  const taxAmount = netAmount * taxRate;
  const totalAmount = netAmount + taxAmount;

  return {
    tierBreakdown,
    subtotal,
    serviceCharge,
    netAmount,
    taxAmount,
    totalAmount,
  };
}
