/**
 * preview-input.ts — unit tests (#204 / PDF2 AC #5).
 *
 * Covers:
 *   (1) Synthesised invoice number uses the operator's prefix
 *   (2) Empty/null prefix falls back to PREVIEW-{year}-PREVIEW
 *   (3) No-microgrid path produces a fake 1-tier rate schedule
 *   (4) Real rate schedule is passed through unchanged
 *   (5) Stable shape — snapshot for regression
 */

import { describe, it, expect } from "vitest";
import {
  assembleSyntheticPreviewInput,
  makePreviewInvoiceNumber,
} from "../preview-input";

const COMMUNITY = {
  id: "00000000-0000-0000-0000-000000000010",
  name: "Sample Community",
  invoice_config: {},
  invoice_prefix: "NFE",
};

const ORGANIZATION = {
  id: "00000000-0000-0000-0000-000000000020",
  name: "Sample Org",
};

const FIXED_NOW = new Date("2026-04-27T12:00:00.000Z");

describe("preview-input", () => {
  it("(1) synthesised invoice number uses the operator's prefix", () => {
    const out = makePreviewInvoiceNumber("NFE", FIXED_NOW);
    expect(out).toBe("NFE-2026-PREVIEW");
  });

  it("(2) empty/null prefix falls back to PREVIEW-{year}-PREVIEW", () => {
    expect(makePreviewInvoiceNumber(null, FIXED_NOW)).toBe("PREVIEW-2026-PREVIEW");
    expect(makePreviewInvoiceNumber("", FIXED_NOW)).toBe("PREVIEW-2026-PREVIEW");
  });

  it("(3) no-microgrid path uses the synthetic 1-tier rate schedule", () => {
    const out = assembleSyntheticPreviewInput({
      community: COMMUNITY,
      organization: ORGANIZATION,
      ratesSchedule: null,
      now: FIXED_NOW,
    });
    const tiers = (out.ratesSchedule as { tiers: Array<Record<string, unknown>> }).tiers;
    expect(tiers).toHaveLength(1);
    expect(tiers[0]).toMatchObject({
      label: "Tier 1",
      min_kwh: 0,
      max_kwh: null,
      rate_per_kwh: 1,
    });
  });

  it("(4) real rate schedule's tiers + service_charge are passed through", () => {
    const real = {
      id: "real-id",
      microgrid_id: "real-mg-id",
      tiers: [
        { label: "Tier 1", min_kwh: 0, max_kwh: 50, rate_per_kwh: 750 },
        { label: "Tier 2", min_kwh: 50, max_kwh: null, rate_per_kwh: 1100 },
      ],
      service_charge: 5000,
      service_charge_description: "Fixed monthly service fee",
      tax_rate: 18,
    };
    const out = assembleSyntheticPreviewInput({
      community: COMMUNITY,
      organization: ORGANIZATION,
      ratesSchedule: real,
      now: FIXED_NOW,
    });
    const passed = out.ratesSchedule as unknown as typeof real;
    expect(passed.tiers).toEqual(real.tiers);
    expect(passed.service_charge).toBe(5000);
    expect(passed.service_charge_description).toBe("Fixed monthly service fee");
  });

  it("(5) top-level shape matches RenderInvoiceInput", () => {
    const out = assembleSyntheticPreviewInput({
      community: COMMUNITY,
      organization: ORGANIZATION,
      ratesSchedule: null,
      now: FIXED_NOW,
    });
    // Renderer-required fields are at the top level (not nested under lineItem).
    expect(out.invoiceNumber).toBe("NFE-2026-PREVIEW");
    expect(out.enteredByUserName).toBe("Sample Operator");
    expect(out.billingPeriodStart).toBe("2026-03-28T12:00:00.000Z");
    expect(out.billingPeriodEnd).toBe("2026-04-27T12:00:00.000Z");
    // Each entity exists.
    expect(out.lineItem).toBeDefined();
    expect(out.household).toBeDefined();
    expect(out.community).toBeDefined();
    expect(out.organization).toBeDefined();
    expect(out.ratesSchedule).toBeDefined();
    expect(out.meterDevice).toBeDefined();
  });
});
