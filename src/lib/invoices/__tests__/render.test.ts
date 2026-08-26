/**
 * render.test.ts — snapshot/structural tests for the PDF1b renderer (#203).
 *
 * Per AC5 (refined 2026-04-29):
 *   - 5 fixtures: F1 full-config-with-logo, F2 minimal-config,
 *     F3 manual-reading, F4 no-payment-provider, F5 no-line-item-payment-link.
 *   - **Mandatory** structural assertions (PDF magic bytes, single page,
 *     expected string presence) — these are the CI gate.
 *   - **Opportunistic** byte-stability assertion behind
 *     `PDF_BYTE_STABILITY=true` env flag (D15). Default behaviour is
 *     structural-only.
 *   - F1's rendered PDF is also written to
 *     `__snapshots__/full-config-with-logo.pdf` as a visual reference
 *     (committed; reviewer can `open` it). Per AC7, this is NOT a CI gate.
 *
 * "Why pdf-parse and not raw bytes-search" (implementer note, supplements
 * the architect note, 2026-04-29): the architect predicted text would be
 * uncompressed in the raw buffer. We verified at install time that
 * `@react-pdf/pdfkit@4.x` defaults `compress = true` (verified at
 * node_modules/@react-pdf/pdfkit/lib/pdfkit.js:42023), so text streams ARE
 * compressed by default and bytes-search misses them. pdf-parse@^2.x
 * (PDFParse class API) is added as a devDep solely for these tests.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, it, expect } from "vitest";
import { PDFParse } from "pdf-parse";

import { renderInvoicePdf, type RenderInvoiceInput } from "@/lib/invoices/render";
import type {
  BillingLineItem,
  Community,
  Device,
  Household,
  Organization,
  RateSchedule,
} from "@/lib/types/domain";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NFE_INVOICE_CONFIG = {
  seller: {
    legal_name: "WattWorks Foundation Limited",
    trade_name: "Nearly Free Energy",
    tax_ids: [
      { label: "BRN", value: "80034460247370" },
      { label: "TIN", value: "1049957756" },
    ],
    address_lines: [
      "Plot / Address Line Here",
      "Kampala / Nansana, Uganda",
    ],
    contact_email: "billing@nearlyfreeenergy.com",
    contact_phone: "+256 762 860 576",
  },
  branding: {
    tagline: "Customer Energy Bill",
    primary_color: "#163a5f",
    accent_color: "#2f7d32",
    document_title: "Invoice",
    whatsapp_number: "+256 762 860 576",
  },
  payment: {
    due_days_after_issue: 8,
  },
  tax: {
    show_section: true,
    category_label: "VAT",
    rate_pct: 18,
  },
  notices: {
    vat_text: null,
    payment_instructions_text: null,
    signature_disclaimer: null,
  },
};

const RATE_SCHEDULE: RateSchedule = {
  id: "rs-1",
  microgrid_id: "mg-1",
  service_charge: 10000,
  service_charge_description: "Fixed monthly service fee",
  tax_rate: 0,
  tiers: [
    { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
    { label: "Tier 2", min_kwh: 51, max_kwh: 150, rate_per_kwh: 600 },
    { label: "Tier 3", min_kwh: 151, max_kwh: null, rate_per_kwh: 750 },
  ],
  created_at: "2026-04-01T00:00:00.000Z",
} as RateSchedule;

// F6 regression fixture (#224): NFE-2026-00003 reproduces Aaron's Tier 2 math
// "0.117 × 756.20 = 88.4754 → 88" reconciliation. Sub-15 max_kwh forces the
// 15.117 usage to spill into Tier 2 by 0.117 kWh.
const RATE_SCHEDULE_REGRESSION: RateSchedule = {
  id: "rs-regression",
  microgrid_id: "mg-1",
  service_charge: 10000,
  service_charge_description: "Fixed monthly service fee",
  tax_rate: 0,
  tiers: [
    { label: "Tier 1", min_kwh: 1, max_kwh: 15, rate_per_kwh: 250 },
    { label: "Tier 2", min_kwh: 16, max_kwh: 80, rate_per_kwh: 756.2 },
  ],
  created_at: "2026-04-01T00:00:00.000Z",
} as RateSchedule;

const ORG: Organization = {
  id: "org-1",
  name: "WattWorks Foundation Limited",
  slug: "wattworks",
  created_at: "2026-01-01T00:00:00.000Z",
} as unknown as Organization;

const COMMUNITY_FULL: Community = {
  id: "comm-1",
  org_id: "org-1",
  name: "Nansana",
  invoice_prefix: "NFE",
  invoice_config: NFE_INVOICE_CONFIG as unknown as Community["invoice_config"],
  created_at: "2026-01-01T00:00:00.000Z",
  payment_provider: "pesapal",
  payment_provider_config: { account: "x" },
  payment_provider_secret_encrypted: null,
  payment_last_configured_at: null,
  address_city: null,
  address_country: null,
  address_line1: null,
  address_line2: null,
  address_postal_code: null,
  address_region: null,
  geography_notes: null,
} as unknown as Community;

const COMMUNITY_MINIMAL: Community = {
  ...COMMUNITY_FULL,
  invoice_config: { tax: { show_section: false, rate_pct: 0 } } as unknown as Community["invoice_config"],
};

const COMMUNITY_NO_PROVIDER: Community = {
  ...COMMUNITY_FULL,
  payment_provider: null,
  payment_provider_config: null,
};

const HOUSEHOLD_AARON: Household = {
  id: "hh-1",
  microgrid_id: "mg-1",
  display_name: "Aaron Tushabe",
  account_number: "ACC-00492",
  meter_serial: "SM-882104",
  meter_type: "Smart Submeter",
  customer_type: "residential",
  primary_email: "aaron@kisakye.ug",
  primary_phone: "+256 700 000 001",
  unit_label: "House 7",
  address_line1: "Community Name",
  address_line2: null,
  address_city: "Nansana",
  address_country: "Uganda",
  address_region: null,
  address_postal_code: null,
  geography_notes: null,
  created_at: "2026-01-01T00:00:00.000Z",
} as unknown as Household;

const METER_DEVICE: Device = {
  id: "dev-1",
  edge_id: "edge-1",
  device_type: "consumption_meter",
  name: "Meter 1",
  openems_component_id: "meter0",
  config: {},
  created_at: "2026-01-01T00:00:00.000Z",
} as unknown as Device;

function makeLineItem(overrides: Partial<BillingLineItem> = {}): BillingLineItem {
  return {
    id: "li-1",
    billing_period_id: "bp-1",
    household_id: "hh-1",
    device_id: "dev-1",
    start_kwh: 1240,
    end_kwh: 1360,
    usage_kwh: 120,
    total_amount: 90860,
    tier_breakdown: [
      { label: "Tier 1", kwh: 50, amount: 25000 },
      { label: "Tier 2", kwh: 70, amount: 42000 },
      { label: "Tier 3", kwh: 0, amount: 0 },
    ],
    payment_status: "unpaid",
    invoice_number: "NFE-2026-00421",
    pesapal_redirect_url: "https://pay.pesapal.com/abc",
    pesapal_order_id: "ORD-1",
    paid_at: null,
    paid_by_user_id: null,
    payment_failed_at: null,
    payment_notes: null,
    payment_refunded_at: null,
    reading_source: "edge",
    entered_at: "2026-04-22T08:30:00.000Z",
    entered_by_user_id: null,
    manual_reason: null,
    created_at: "2026-04-22T08:30:00.000Z",
    ...overrides,
  } as BillingLineItem;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const SNAPSHOT_DIR = path.join(__dirname, "__snapshots__");
const VISUAL_REFERENCE_PATH = path.join(
  SNAPSHOT_DIR,
  "full-config-with-logo.pdf",
);

function loadLogoBytes(): Buffer | null {
  const logoPath = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "..",
    "..",
    "..",
    "mbe-docs",
    "design",
    "assets",
    "nfe-logo.png",
  );
  try {
    if (existsSync(logoPath)) {
      return readFileSync(logoPath);
    }
  } catch {
    // Logo not present (CI without mbe-docs sibling) — fall through to null.
  }
  return null;
}

async function expectStructuralPdfShape(
  buf: Buffer,
  expectedStrings: string[],
  forbiddenStrings: string[] = [],
): Promise<void> {
  // Magic header.
  expect(buf.subarray(0, 4).toString()).toBe("%PDF");

  // Page count + text content via pdf-parse. The PDF dictionary uses
  // `/Type /Pages` + `/Count <n>` in the page tree but @react-pdf/pdfkit
  // compresses text streams (`compress=true` default), so bytes-search
  // does not see rendered text — pdf-parse is the clean route.
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    expect(
      result.pages?.length,
      "Invoice should be rendered as a single page",
    ).toBe(1);
    const text = result.text ?? "";

    for (const s of expectedStrings) {
      expect(
        text.includes(s),
        `Expected PDF text to contain "${s}". Got first 400 chars: ${text.substring(0, 400)}`,
      ).toBe(true);
    }
    for (const s of forbiddenStrings) {
      expect(
        text.includes(s),
        `Expected PDF text NOT to contain "${s}". Got first 400 chars: ${text.substring(0, 400)}`,
      ).toBe(false);
    }
  } finally {
    await parser.destroy();
  }
}

function maybeAssertByteStability(fixtureName: string, buf: Buffer): void {
  if (process.env.PDF_BYTE_STABILITY !== "true") return;
  const hashPath = path.join(SNAPSHOT_DIR, `${fixtureName}.sha256`);
  const hash = createHash("sha256").update(buf).digest("hex");
  if (!existsSync(hashPath)) {
    if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(hashPath, hash);
    return;
  }
  const expected = readFileSync(hashPath, "utf8").trim();
  expect(hash).toBe(expected);
}

// ── Fixtures: input bags ─────────────────────────────────────────────────────

function buildF1Input(): RenderInvoiceInput {
  return {
    lineItem: makeLineItem(),
    household: HOUSEHOLD_AARON,
    community: COMMUNITY_FULL,
    organization: ORG,
    ratesSchedule: RATE_SCHEDULE,
    paymentRedirectUrl: "http://localhost:3000/api/billing-line-items/li-1/pay",
    invoiceNumber: "NFE-2026-00421",
    logoBytes: loadLogoBytes(),
    meterDevice: METER_DEVICE,
    enteredByUserName: null,
    currency: "UGX",
    billingPeriodStart: "2026-04-01",
    billingPeriodEnd: "2026-04-30",
    // #358 — stamped zone (label of record; must not shift the range).
    billingPeriodTimezone: "Africa/Kampala",
  };
}

function buildF2Input(): RenderInvoiceInput {
  return {
    lineItem: makeLineItem(),
    household: { ...HOUSEHOLD_AARON, account_number: null, meter_serial: null },
    community: COMMUNITY_MINIMAL,
    organization: ORG,
    ratesSchedule: RATE_SCHEDULE,
    paymentRedirectUrl: "http://localhost:3000/api/billing-line-items/li-1/pay",
    invoiceNumber: "WW-2026-00001",
    logoBytes: null,
    meterDevice: null,
    enteredByUserName: null,
    currency: "UGX",
    billingPeriodStart: "2026-04-01",
    billingPeriodEnd: "2026-04-30",
  };
}

function buildF3Input(): RenderInvoiceInput {
  return {
    lineItem: makeLineItem({
      reading_source: "manual",
      entered_at: "2026-04-22T10:00:00.000Z",
      entered_by_user_id: "user-aaron",
      manual_reason: "End-of-month manual read",
    }),
    household: HOUSEHOLD_AARON,
    community: COMMUNITY_FULL,
    organization: ORG,
    ratesSchedule: RATE_SCHEDULE,
    paymentRedirectUrl: "http://localhost:3000/api/billing-line-items/li-1/pay",
    invoiceNumber: "NFE-2026-00422",
    logoBytes: null,
    meterDevice: METER_DEVICE,
    enteredByUserName: "Aaron Tushabe",
    currency: "UGX",
    billingPeriodStart: "2026-04-01",
    billingPeriodEnd: "2026-04-30",
  };
}

function buildF4Input(): RenderInvoiceInput {
  return {
    lineItem: makeLineItem({ pesapal_redirect_url: null, pesapal_order_id: null }),
    household: HOUSEHOLD_AARON,
    community: COMMUNITY_NO_PROVIDER,
    organization: ORG,
    ratesSchedule: RATE_SCHEDULE,
    paymentRedirectUrl: null, // no provider configured
    invoiceNumber: "NFE-2026-00423",
    logoBytes: null,
    meterDevice: METER_DEVICE,
    enteredByUserName: null,
    currency: "UGX",
    billingPeriodStart: "2026-04-01",
    billingPeriodEnd: "2026-04-30",
  };
}

function buildF5Input(): RenderInvoiceInput {
  return {
    lineItem: makeLineItem({ pesapal_redirect_url: null, pesapal_order_id: null }),
    household: HOUSEHOLD_AARON,
    community: COMMUNITY_FULL, // provider IS configured
    organization: ORG,
    ratesSchedule: RATE_SCHEDULE,
    paymentRedirectUrl: null, // …but the renderer received null anyway
    invoiceNumber: "NFE-2026-00424",
    logoBytes: null,
    meterDevice: METER_DEVICE,
    enteredByUserName: null,
    currency: "UGX",
    billingPeriodStart: "2026-04-01",
    billingPeriodEnd: "2026-04-30",
  };
}

// F6 (#224 regression): reproduces Arthur Bamwite's NFE-2026-00003 — the
// stored Tier 2 usage of 0.117 kWh at rate 756.2 UGX/kWh must display so
// that 0.117 × 756.20 ≈ 88 UGX reconciles for the customer.
function buildF6Input(): RenderInvoiceInput {
  return {
    lineItem: makeLineItem({
      start_kwh: 1000,
      end_kwh: 1015.117,
      usage_kwh: 15.117,
      tier_breakdown: [
        { label: "Tier 1", kwh: 15, amount: 3750 },
        { label: "Tier 2", kwh: 0.117, amount: 88.4754 },
      ],
      // 3750 + 88.4754 + 10000 service_charge ≈ 13838 (no tax)
      total_amount: 13838,
      invoice_number: "NFE-2026-00003",
    }),
    household: HOUSEHOLD_AARON,
    community: COMMUNITY_MINIMAL, // tax hidden — keep focus on rate/usage math
    organization: ORG,
    ratesSchedule: RATE_SCHEDULE_REGRESSION,
    paymentRedirectUrl: null,
    invoiceNumber: "NFE-2026-00003",
    logoBytes: null,
    meterDevice: METER_DEVICE,
    enteredByUserName: null,
    currency: "UGX",
    billingPeriodStart: "2026-04-01",
    billingPeriodEnd: "2026-04-30",
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("renderInvoicePdf — fixtures (#203 PDF1b)", () => {
  it("F1 full-config-with-logo: edge reading + tax + payment card + logo", async () => {
    const input = buildF1Input();
    const buf = await renderInvoicePdf(input);

    // Always write the visual reference first — even if assertions fail
    // we want the maintainer to be able to inspect the produced PDF.
    if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(VISUAL_REFERENCE_PATH, buf);

    await expectStructuralPdfShape(buf, [
      "NFE-2026-00421",
      "WattWorks Foundation Limited",
      "Aaron Tushabe",
      "Edge reading captured",
      "Pay Now",
      "VAT",
      // #358 — stamped period timezone beside the Billing Period range.
      // Asserted as two tokens: the narrow meta cell line-wraps between
      // the id and the offset, so pdf-parse text extraction inserts a
      // newline inside "Africa/Kampala (UTC+3)".
      "Africa/Kampala",
      "(UTC+3)",
    ]);

    maybeAssertByteStability("full-config-with-logo", buf);
  });

  it("F2 minimal-config: tax explicitly hidden, no logo, org-name fallback", async () => {
    const input = buildF2Input();
    const buf = await renderInvoicePdf(input);

    await expectStructuralPdfShape(
      buf,
      [
        "WW-2026-00001",
        // Falls back to org name when seller.legal_name is absent.
        "WattWorks Foundation Limited",
      ],
      ["VAT @ 18%"], // tax section hidden
    );

    maybeAssertByteStability("minimal-config", buf);
  });

  it("F3 manual-reading: 'Manual entry by …' + reason line", async () => {
    const input = buildF3Input();
    const buf = await renderInvoicePdf(input);

    await expectStructuralPdfShape(buf, [
      "NFE-2026-00422",
      "Manual entry by Aaron Tushabe",
      "End-of-month manual read",
    ]);

    maybeAssertByteStability("manual-reading", buf);
  });

  it("F4 no-payment-provider: Payment Information card omitted", async () => {
    const input = buildF4Input();
    const buf = await renderInvoicePdf(input);

    await expectStructuralPdfShape(
      // Card-header text is rendered uppercase via textTransform; assert
      // against the rendered form, not the JSX literal.
      buf,
      ["NFE-2026-00423", "CUSTOMER SUPPORT"],
      ["Pay Now", "PAYMENT INFORMATION"], // card omitted
    );

    maybeAssertByteStability("no-payment-provider", buf);
  });

  it("F5 no-line-item-payment-link: paymentRedirectUrl=null → card omitted", async () => {
    const input = buildF5Input();
    const buf = await renderInvoicePdf(input);

    await expectStructuralPdfShape(
      buf,
      ["NFE-2026-00424"],
      ["Pay Now"], // paymentRedirectUrl=null → card omitted
    );

    maybeAssertByteStability("no-line-item-payment-link", buf);
  });

  it("F6 regression #224 — NFE-2026-00003 Tier 2 reconciles 0.117 × 756.20 to 88", async () => {
    const input = buildF6Input();
    const buf = await renderInvoicePdf(input);

    await expectStructuralPdfShape(
      buf,
      [
        "NFE-2026-00003",
        // Tier 2 usage cell — preserved at digits:3, not rounded to "0.12".
        "0.117",
        // Current Reading / Total Consumption preserved at digits:3.
        "15.117",
        // Tier 2 rate cell — formatRate pads 756.2 → "756.20".
        "756.20",
        // Tier 1 rate cell — formatRate pads integer 250 → "250.00".
        "250.00",
      ],
      [
        // Old formatKwh(digits:2) would have rounded 0.117 → "0.12". The
        // fixture's stored numbers (3750, 88.4754, 13838, 15.117, 0.117,
        // 250, 756.2, 10000) deliberately don't include a "0.12" substring,
        // so this assertion is targeted.
        "0.12",
        // Old formatCurrency(bareNumber:true) would have rendered 756.2 as
        // "756". The trailing space avoids colliding with "756.20".
        "756 ",
      ],
    );

    // Per-row reconciliation: displayed_usage × displayed_rate must round
    // to within ±1 UGX of displayed_amount. The integer-UGX rounding
    // allowance is what makes the math feel right to the customer; exact
    // equality is not the bar.
    const reconcile = (usage: number, rate: number, amount: number) =>
      Math.abs(Math.round(usage * rate) - amount) <= 1;
    expect(reconcile(0.117, 756.20, 88)).toBe(true);
    expect(reconcile(15.000, 250.00, 3750)).toBe(true);

    maybeAssertByteStability("regression-nfe-2026-00003", buf);
  });

  // ── #358 — per-period timezone on the invoice PDF ──────────────────────────

  it("#358: omitted billingPeriodTimezone → no zone label (historical callers)", async () => {
    const input = { ...buildF1Input(), logoBytes: null };
    delete (input as Partial<RenderInvoiceInput>).billingPeriodTimezone;
    const buf = await renderInvoicePdf(input);
    await expectStructuralPdfShape(buf, ["NFE-2026-00421"], ["Africa/Kampala"]);
  });

  it("#358 HARD guard: the stamped zone labels the range but never shifts the window dates", async () => {
    // Pacific/Midway is UTC-11 year-round. If billingPeriodTimezone were
    // (incorrectly) fed into date formatting, the plain calendar DATEs
    // 2026-04-01 / 2026-04-30 (parsed as UTC midnight) would render as
    // 31 Mar / 29 Apr. They must render as-is: "1 Apr – 30 Apr" (the
    // year wraps to the next extracted line, so it's asserted separately
    // via the forbidden shifted forms). The range formatter is pinned to
    // timeZone: "UTC" so this holds on any host TZ, not just UTC runners.
    const buf = await renderInvoicePdf({
      ...buildF1Input(),
      logoBytes: null,
      billingPeriodTimezone: "Pacific/Midway",
    });
    await expectStructuralPdfShape(
      buf,
      ["Pacific/Midway", "(UTC-11)", "1 Apr – 30 Apr"],
      ["31 Mar", "29 Apr –", "– 29 Apr"],
    );
  });

  it("rejects invalid invoice_config via parseInvoiceConfig (ZodError)", async () => {
    const input = buildF1Input();
    // Inject an invalid color (4-char hex) — Zod will throw.
    const broken = {
      ...COMMUNITY_FULL,
      invoice_config: {
        ...NFE_INVOICE_CONFIG,
        branding: { ...NFE_INVOICE_CONFIG.branding, primary_color: "#abc" },
      } as unknown as Community["invoice_config"],
    };
    await expect(
      renderInvoicePdf({ ...input, community: broken }),
    ).rejects.toThrowError(/primary_color|7-character hex|invalid_string|hex/i);
  });
});
