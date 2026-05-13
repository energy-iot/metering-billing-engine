import type { TierConfig, TierBreakdown } from "@/lib/types/domain";
import { roundKwh, roundAmount } from "./precision";

export type BillingCalculation = {
  tierBreakdown: TierBreakdown[];
  subtotal: number; // sum of tier amounts
  serviceCharge: number; // pass-through
  netAmount: number; // subtotal + serviceCharge
  taxAmount: number; // netAmount * taxRate
  totalAmount: number; // netAmount + taxAmount
};

// #227: every numeric output that lands in storage or display is
// rounded here so any caller (runGenerationFor, TierEditor preview,
// usage/route test fixture, etc.) gets clean values. Defense-in-depth
// with the rounding in `runGenerationFor` and `fn_record_line_item_with_audit`.
//
// kWh values use `roundKwh` (3 decimals = mWh precision). UGX amounts
// use `roundAmount` (integer — UGX has no minor units, and the bill
// display rounds to integer anyway). Tax is computed against the
// already-integer netAmount so `taxAmount` and `totalAmount` are integer
// by construction.

export function calculateTieredCost(
  usageKwh: number,
  tiers: TierConfig[],
  serviceCharge: number,
  taxRate: number
): BillingCalculation {
  if (usageKwh <= 0 || tiers.length === 0) {
    const netAmount = roundAmount(serviceCharge);
    const taxAmount = roundAmount(netAmount * taxRate);
    return {
      tierBreakdown: [],
      subtotal: 0,
      serviceCharge: roundAmount(serviceCharge),
      netAmount,
      taxAmount,
      totalAmount: roundAmount(netAmount + taxAmount),
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
      kwh: roundKwh(kwhInTier),
      amount: roundAmount(amount),
    });

    remaining -= kwhInTier;
  }

  const subtotal = roundAmount(
    tierBreakdown.reduce((sum, t) => sum + t.amount, 0)
  );
  const netAmount = roundAmount(subtotal + serviceCharge);
  const taxAmount = roundAmount(netAmount * taxRate);
  const totalAmount = roundAmount(netAmount + taxAmount);

  return {
    tierBreakdown,
    subtotal,
    serviceCharge: roundAmount(serviceCharge),
    netAmount,
    taxAmount,
    totalAmount,
  };
}
