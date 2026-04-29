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
    expect(out.ratesSchedule.tiers).toHaveLength(1);
    expect(out.ratesSchedule.tiers[0]).toMatchObject({
      label: "Tier 1",
      min_kwh: 0,
      max_kwh: null,
      rate_per_kwh: 1,
    });
    expect(out.ratesSchedule.service_charge).toBe(0);
    expect(out.ratesSchedule.tax_rate).toBe(0);
  });

  it("(4) real rate schedule is passed through unchanged", () => {
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
    expect(out.ratesSchedule).toEqual(real);
    expect(out.lineItem.service_charge).toBe(5000);
  });

  it("(5) shape is stable — snapshot", () => {
    const out = assembleSyntheticPreviewInput({
      community: COMMUNITY,
      organization: ORGANIZATION,
      ratesSchedule: null,
      now: FIXED_NOW,
    });
    expect(out).toMatchInlineSnapshot(`
      {
        "community": {
          "id": "00000000-0000-0000-0000-000000000010",
          "invoice_config": {},
          "invoice_prefix": "NFE",
          "name": "Sample Community",
        },
        "enteredByUserName": "Sample Operator",
        "household": {
          "account_number": "ACC-0001",
          "contact_email": null,
          "customer_type": "residential",
          "display_name": "Sample Household",
          "id": "00000000-0000-0000-0000-000000000001",
          "meter_serial": "SM-PREVIEW-0001",
          "meter_type": "Smart Submeter",
        },
        "lineItem": {
          "created_at": "2026-04-27T12:00:00.000Z",
          "due_date": "2026-05-05T12:00:00.000Z",
          "end_kwh": 14624.75,
          "id": "00000000-0000-0000-0000-000000000004",
          "invoice_number": "NFE-2026-PREVIEW",
          "issue_date": "2026-04-27T12:00:00.000Z",
          "pre_tax_total": 124.5,
          "service_charge": 0,
          "start_kwh": 14500.25,
          "subtotal": 124.5,
          "tax_amount": 0,
          "tier_breakdown": [
            {
              "label": "Tier 1",
              "rate_per_kwh": 1,
              "subtotal": 124.5,
              "usage_kwh": 124.5,
            },
          ],
          "total": 124.5,
          "usage_kwh": 124.5,
        },
        "meterDevice": {
          "device_type": "metering",
          "display_name": "Smart Submeter (Preview)",
          "id": "00000000-0000-0000-0000-000000000002",
        },
        "organization": {
          "id": "00000000-0000-0000-0000-000000000020",
          "name": "Sample Org",
        },
        "period": {
          "end_at": "2026-04-27T12:00:00.000Z",
          "id": "00000000-0000-0000-0000-000000000003",
          "label": "Sample period",
          "start_at": "2026-03-28T12:00:00.000Z",
        },
        "ratesSchedule": {
          "id": "00000000-0000-0000-0000-000000000000",
          "microgrid_id": "00000000-0000-0000-0000-000000000000",
          "service_charge": 0,
          "service_charge_description": null,
          "tax_rate": 0,
          "tiers": [
            {
              "label": "Tier 1",
              "max_kwh": null,
              "min_kwh": 0,
              "rate_per_kwh": 1,
            },
          ],
        },
      }
    `);
  });
});
