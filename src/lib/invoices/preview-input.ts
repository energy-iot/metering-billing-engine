/**
 * preview-input.ts — Synthesises a `RenderInvoiceInput` for the operator
 * preview button (#204 / PDF2 AC #5).
 *
 * The preview must show the operator their branding/layout choices without
 * consuming a real invoice counter. We assemble a plausible-looking sample:
 *
 *   - Synthetic invoice number `${invoice_prefix || 'PREVIEW'}-{year}-PREVIEW`.
 *   - Synthetic line item with usage spread across tiers.
 *   - Synthetic household + meter device with stable display names.
 *   - Real `ratesSchedule` from the community's first microgrid; if no
 *     microgrid exists yet, a fake 1-tier schedule.
 *
 * Contract:
 *   - Pure helper (no I/O). The route fetches the microgrid's rate_schedule
 *     beforehand and passes it in, OR passes `null` to opt into the synthetic
 *     1-tier fallback.
 *   - Returns `Omit<RenderInvoiceInput, 'logoBytes' | 'paymentRedirectUrl'>` —
 *     the route adds those two after fetching/synthesising them.
 *
 * The shape produced here mirrors PDF1b's `RenderInvoiceInput` spec from
 * `mbe-docs/docs/tickets/pdf-invoices/PDF1b-renderer-and-pdf-endpoint.md`.
 * If the renderer's input bag changes, this helper must change in lockstep.
 */

import type { InvoiceConfig } from "./config-schema";

/**
 * Minimal community-like input needed by the preview helper. Mirrors the
 * fields the renderer reads — keeps the helper decoupled from the row shape.
 */
export type PreviewCommunityInput = {
  id: string;
  name: string;
  invoice_config: InvoiceConfig | Record<string, never>;
  invoice_prefix: string | null;
};

export type PreviewOrganizationInput = {
  id: string;
  name: string;
};

/**
 * Synthesised rate-schedule shape used when the community has no microgrid
 * yet. Mirrors `rate_schedules` row plus the `description` column added in
 * 00033 for tier-level service-charge captions.
 */
export type PreviewRateSchedule = {
  id: string;
  microgrid_id: string;
  tiers: Array<{
    label: string;
    min_kwh: number;
    max_kwh: number | null;
    rate_per_kwh: number;
  }>;
  service_charge: number;
  service_charge_description: string | null;
  tax_rate: number;
};

const FAKE_RATE_SCHEDULE: PreviewRateSchedule = {
  id: "00000000-0000-0000-0000-000000000000",
  microgrid_id: "00000000-0000-0000-0000-000000000000",
  tiers: [
    {
      label: "Tier 1",
      min_kwh: 0,
      max_kwh: null,
      rate_per_kwh: 1,
    },
  ],
  service_charge: 0,
  service_charge_description: null,
  tax_rate: 0,
};

/**
 * Build the synthetic invoice number for the preview. Never increments the
 * real `fn_next_invoice_number()` — operator preview MUST NOT consume the
 * counter.
 */
export function makePreviewInvoiceNumber(
  invoicePrefix: string | null,
  now: Date = new Date(),
): string {
  const prefix =
    invoicePrefix && invoicePrefix.length > 0 ? invoicePrefix : "PREVIEW";
  const year = now.getUTCFullYear();
  return `${prefix}-${year}-PREVIEW`;
}

/**
 * Synthesise a preview-input payload (everything except `logoBytes` and
 * `paymentRedirectUrl`, which the route layers on after fetching/synthesising
 * them).
 *
 * @param community — the community row (id, name, invoice_config, invoice_prefix).
 * @param organization — the parent org (id, name).
 * @param ratesSchedule — the microgrid's actual rate schedule, OR null to
 *   trigger the synthetic 1-tier fallback (operator is configuring before any
 *   microgrid exists yet).
 * @param now — clock injection point for tests.
 */
export function assembleSyntheticPreviewInput({
  community,
  organization,
  ratesSchedule,
  now = new Date(),
}: {
  community: PreviewCommunityInput;
  organization: PreviewOrganizationInput;
  ratesSchedule: PreviewRateSchedule | null;
  now?: Date;
}) {
  const periodEnd = new Date(now);
  const periodStart = new Date(now);
  periodStart.setUTCDate(periodStart.getUTCDate() - 30);

  const issueDate = now;
  const dueDays =
    (community.invoice_config as InvoiceConfig | undefined)?.payment
      ?.due_days_after_issue ?? 8;
  const dueDate = new Date(now);
  dueDate.setUTCDate(dueDate.getUTCDate() + dueDays);

  const usageKwh = 124.5;
  const startKwh = 14_500.25;
  const endKwh = startKwh + usageKwh;

  const effectiveRates = ratesSchedule ?? FAKE_RATE_SCHEDULE;

  // Tier breakdown: at N=124.5 kWh the breakdown is naive — full usage in the
  // first tier (preview is for branding, not billing arithmetic correctness).
  const tierBreakdown = effectiveRates.tiers.map((t, i) => ({
    label: t.label,
    rate_per_kwh: t.rate_per_kwh,
    usage_kwh: i === 0 ? usageKwh : 0,
    subtotal: i === 0 ? usageKwh * t.rate_per_kwh : 0,
  }));

  const subtotal = tierBreakdown.reduce((sum, t) => sum + t.subtotal, 0);
  const serviceCharge = effectiveRates.service_charge;
  const preTaxTotal = subtotal + serviceCharge;
  const taxAmount = preTaxTotal * (effectiveRates.tax_rate / 100);
  const grandTotal = preTaxTotal + taxAmount;

  const invoiceNumber = makePreviewInvoiceNumber(community.invoice_prefix, now);

  return {
    organization: {
      id: organization.id,
      name: organization.name,
    },
    community: {
      id: community.id,
      name: community.name,
      invoice_config: community.invoice_config,
      invoice_prefix: community.invoice_prefix,
    },
    household: {
      id: "00000000-0000-0000-0000-000000000001",
      display_name: "Sample Household",
      account_number: "ACC-0001",
      contact_email: null,
      customer_type: "residential",
      meter_serial: "SM-PREVIEW-0001",
      meter_type: "Smart Submeter",
    },
    meterDevice: {
      id: "00000000-0000-0000-0000-000000000002",
      display_name: "Smart Submeter (Preview)",
      device_type: "metering",
    },
    period: {
      id: "00000000-0000-0000-0000-000000000003",
      start_at: periodStart.toISOString(),
      end_at: periodEnd.toISOString(),
      label: "Sample period",
    },
    lineItem: {
      id: "00000000-0000-0000-0000-000000000004",
      invoice_number: invoiceNumber,
      created_at: now.toISOString(),
      issue_date: issueDate.toISOString(),
      due_date: dueDate.toISOString(),
      start_kwh: startKwh,
      end_kwh: endKwh,
      usage_kwh: usageKwh,
      tier_breakdown: tierBreakdown,
      subtotal,
      service_charge: serviceCharge,
      pre_tax_total: preTaxTotal,
      tax_amount: taxAmount,
      total: grandTotal,
    },
    ratesSchedule: effectiveRates,
    enteredByUserName: "Sample Operator",
  };
}
