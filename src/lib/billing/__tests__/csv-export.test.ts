/**
 * csv-export.test.ts — pure-function tests for #229 CSV serializer.
 *
 * The helper is fully data-driven; these tests cover the AC-spec'd
 * invariants:
 *   - 19-column header (+ 2 per tier).
 *   - Per-row VAT/service/subtotal derivation from
 *     `community.invoice_config.tax.rate_pct` (NOT `rateSchedule.tax_rate`).
 *   - Tier column lookup by `label`, not index (re-ordered breakdowns
 *     still align).
 *   - Address composition mirrors the PDF's 5-field filter+join.
 *   - BOM byte sequence + CRLF line endings + RFC 4180 quoting.
 *   - Sort stability (display_name asc, line-item id asc secondary).
 *   - Special characters (commas, quotes, newlines) are properly escaped.
 *   - Filename sanitization helper edge cases.
 */

import { describe, it, expect } from "vitest";
import {
  buildBillingPeriodCsv,
  buildCsvFilename,
  sanitizeFilenameSegment,
  type CsvExportInput,
  type CsvExportRow,
} from "../csv-export";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const TIERS_4 = [
  { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
  { label: "Tier 2", min_kwh: 51, max_kwh: 100, rate_per_kwh: 800 },
  { label: "Tier 3", min_kwh: 101, max_kwh: 200, rate_per_kwh: 1100 },
  { label: "Tier 4", min_kwh: 201, max_kwh: null, rate_per_kwh: 1400 },
];

const TIERS_2 = [
  { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
  { label: "Tier 2", min_kwh: 51, max_kwh: null, rate_per_kwh: 800 },
];

function makeRow(overrides: Partial<CsvExportRow> = {}): CsvExportRow {
  return {
    household: {
      display_name: "Alice",
      account_number: "A-001",
      meter_serial: "MS-001",
      meter_type: "Smart Submeter",
      customer_type: "residential",
      // Default to comma-free fields so most tests can naively
      // `.split(",")` to assert per-cell values. Tests that exercise
      // address composition override these explicitly.
      unit_label: null,
      address_line1: null,
      address_line2: null,
      address_city: null,
      address_country: null,
      primary_phone: "+256700000001",
    },
    device: { openems_component_id: "meter0" },
    lineItem: {
      id: "00000000-0000-0000-0000-000000000001",
      invoice_number: "NFE-2026-00001",
      created_at: "2026-04-30T08:30:00Z",
      start_kwh: 100,
      end_kwh: 180,
      usage_kwh: 80,
      tier_breakdown: [
        { label: "Tier 1", kwh: 50, amount: 25000 },
        { label: "Tier 2", kwh: 30, amount: 24000 },
      ],
      total_amount: 49000,
      payment_status: "unpaid",
      paid_at: null,
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<CsvExportInput> = {}): CsvExportInput {
  return {
    microgrid: { name: "Sezibwa", currency: "UGX" },
    period: {
      id: "00000000-0000-0000-0000-0000000000aa",
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      status: "closed",
    },
    rateSchedule: {
      tiers: TIERS_2,
      service_charge: 0,
      tax_rate: 0,
    },
    invoiceConfig: {
      tax: { show_section: false, rate_pct: 0 },
    },
    rows: [makeRow()],
    ...overrides,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseLines(csv: string): string[] {
  // Strip BOM if present, split on CRLF, drop trailing empty (from
  // terminator).
  const body = csv.startsWith("﻿") ? csv.slice(1) : csv;
  const lines = body.split("\r\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("buildBillingPeriodCsv — header + structure", () => {
  it("emits 18 fixed columns + 2 per tier (4-tier microgrid → 26 columns)", () => {
    // AC bullet #13 is the per-tier block (counted as a single item in
    // the spec's "19-column header" phrasing → 18 individual non-tier
    // columns).
    const csv = buildBillingPeriodCsv(
      makeInput({ rateSchedule: { tiers: TIERS_4, service_charge: 0, tax_rate: 0 } }),
    );
    const lines = parseLines(csv);
    const headerCols = lines[0].split(",");
    expect(headerCols.length).toBe(18 + 8);
    expect(headerCols[0]).toBe("Invoice Number");
    expect(headerCols[1]).toBe("Issue Date");
    expect(headerCols[2]).toBe("Household");
    expect(headerCols[5]).toBe("Meter Type");
    expect(headerCols[7]).toBe("Address");
  });

  it("2-tier microgrid → 18 + 4 = 22 columns", () => {
    const csv = buildBillingPeriodCsv(makeInput());
    const cols = parseLines(csv)[0].split(",");
    expect(cols.length).toBe(18 + 4);
  });

  it("currency token threads into Service / VAT / Total / tier headers", () => {
    const csv = buildBillingPeriodCsv(
      makeInput({ microgrid: { name: "X", currency: "KES" } }),
    );
    const cols = parseLines(csv)[0].split(",");
    expect(cols).toContain("Service Charge KES");
    expect(cols).toContain("Taxable Subtotal KES");
    expect(cols).toContain("VAT KES");
    expect(cols).toContain("Total KES");
    expect(cols).toContain("Tier 1 KES");
    expect(cols).toContain("Tier 2 KES");
  });

  it("empty rows array → header-only CSV (single line)", () => {
    const csv = buildBillingPeriodCsv(makeInput({ rows: [] }));
    const lines = parseLines(csv);
    expect(lines.length).toBe(1);
  });
});

describe("buildBillingPeriodCsv — bytes (BOM + CRLF)", () => {
  it("starts with UTF-8 BOM (0xEF 0xBB 0xBF)", () => {
    const csv = buildBillingPeriodCsv(makeInput());
    const bytes = new Uint8Array(Buffer.from(csv, "utf-8"));
    expect(Array.from(bytes.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("uses CRLF line endings between rows", () => {
    const csv = buildBillingPeriodCsv(
      makeInput({ rows: [makeRow(), makeRow({ household: { ...makeRow().household, display_name: "Bob" } })] }),
    );
    // Count CRLF occurrences = header + 2 data rows + trailing = 3
    const crlfCount = (csv.match(/\r\n/g) ?? []).length;
    expect(crlfCount).toBe(3);
    expect(csv.endsWith("\r\n")).toBe(true);
  });
});

describe("buildBillingPeriodCsv — tier lookup", () => {
  it("4-tier microgrid: rows that reached only Tier 1 emit empty cells for Tiers 2-4 (NOT zero)", () => {
    const rowOnlyT1 = makeRow({
      household: { ...makeRow().household, display_name: "Solo" },
      lineItem: {
        ...makeRow().lineItem,
        id: "00000000-0000-0000-0000-000000000010",
        tier_breakdown: [{ label: "Tier 1", kwh: 25, amount: 12500 }],
        total_amount: 12500,
      },
    });
    const csv = buildBillingPeriodCsv(
      makeInput({
        rateSchedule: { tiers: TIERS_4, service_charge: 0, tax_rate: 0 },
        rows: [rowOnlyT1],
      }),
    );
    const lines = parseLines(csv);
    const dataCols = lines[1].split(",");
    // Tier columns start at index 12. T1 kWh = 25, T1 UGX = 12500,
    // T2/T3/T4 kWh + UGX should be empty strings.
    expect(dataCols[12]).toBe("25");
    expect(dataCols[13]).toBe("12500");
    expect(dataCols[14]).toBe("");
    expect(dataCols[15]).toBe("");
    expect(dataCols[16]).toBe("");
    expect(dataCols[17]).toBe("");
    expect(dataCols[18]).toBe("");
    expect(dataCols[19]).toBe("");
  });

  it("empty tier_breakdown ([]) — all tier cells are empty", () => {
    const rowEmpty = makeRow({
      lineItem: {
        ...makeRow().lineItem,
        tier_breakdown: [],
        total_amount: 0,
      },
    });
    const csv = buildBillingPeriodCsv(
      makeInput({
        rateSchedule: { tiers: TIERS_4, service_charge: 0, tax_rate: 0 },
        rows: [rowEmpty],
      }),
    );
    const dataCols = parseLines(csv)[1].split(",");
    for (let i = 12; i < 12 + 8; i++) {
      expect(dataCols[i]).toBe("");
    }
  });

  it("tier lookup is BY LABEL not index — re-ordered tier_breakdown still aligns", () => {
    const reorderedRow = makeRow({
      lineItem: {
        ...makeRow().lineItem,
        // T2 listed BEFORE T1 — must still align under the right column.
        tier_breakdown: [
          { label: "Tier 2", kwh: 30, amount: 24000 },
          { label: "Tier 1", kwh: 50, amount: 25000 },
        ],
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [reorderedRow] }));
    const cols = parseLines(csv)[1].split(",");
    // Column 12 = Tier 1 kWh, 13 = Tier 1 UGX, 14 = Tier 2 kWh, 15 = Tier 2 UGX
    expect(cols[12]).toBe("50");
    expect(cols[13]).toBe("25000");
    expect(cols[14]).toBe("30");
    expect(cols[15]).toBe("24000");
  });
});

describe("buildBillingPeriodCsv — VAT/tax derivation", () => {
  it("VAT enabled (show_section=true, rate_pct=18) → VAT-from-total math", () => {
    // total = 49000 → net = round(49000/1.18) = round(41525.4237…) = 41525
    // VAT = 49000 - 41525 = 7475
    const csv = buildBillingPeriodCsv(
      makeInput({
        invoiceConfig: { tax: { show_section: true, rate_pct: 18 } },
        rateSchedule: { tiers: TIERS_2, service_charge: 0, tax_rate: 0.18 },
        rows: [makeRow()],
      }),
    );
    const cols = parseLines(csv)[1].split(",");
    // Header order, after 4 tier cols: Service / Taxable / VAT / Total
    // base cols 0-11 + 4 tier cols = first non-tier index is 16
    // 16=Service Charge, 17=Taxable Subtotal, 18=VAT, 19=Total
    expect(cols[16]).toBe("0"); // service charge
    expect(cols[17]).toBe("41525"); // taxable subtotal
    expect(cols[18]).toBe("7475"); // VAT
    expect(cols[19]).toBe("49000"); // total
  });

  it("VAT disabled (show_section=false) → VAT cell EMPTY, taxable = energy + service", () => {
    const csv = buildBillingPeriodCsv(
      makeInput({
        invoiceConfig: { tax: { show_section: false, rate_pct: 0 } },
        rateSchedule: { tiers: TIERS_2, service_charge: 5000, tax_rate: 0 },
        rows: [makeRow()],
      }),
    );
    const cols = parseLines(csv)[1].split(",");
    // energy = 25000 + 24000 = 49000, +service 5000 = 54000 taxable, VAT empty
    expect(cols[16]).toBe("5000"); // service charge
    expect(cols[17]).toBe("54000"); // taxable subtotal = energy + service
    expect(cols[18]).toBe(""); // VAT empty (not zero)
  });

  it("VAT rate_pct=0 → VAT cell EMPTY (treated as disabled)", () => {
    const csv = buildBillingPeriodCsv(
      makeInput({
        invoiceConfig: { tax: { show_section: true, rate_pct: 0 } },
        rows: [makeRow()],
      }),
    );
    const cols = parseLines(csv)[1].split(",");
    expect(cols[18]).toBe("");
  });

  it("ANTI-TEST: VAT does NOT come from rateSchedule.tax_rate — only from invoiceConfig.tax.rate_pct", () => {
    // If the helper (buggily) used rateSchedule.tax_rate=0.20, the VAT
    // for total=49000 would be 49000 - round(49000/1.20) = 8167.
    // But we set invoiceConfig.tax.rate_pct=10 → VAT should be 4455
    // (49000 - round(49000/1.10) = 49000 - 44545 = 4455).
    const csv = buildBillingPeriodCsv(
      makeInput({
        invoiceConfig: { tax: { show_section: true, rate_pct: 10 } },
        rateSchedule: { tiers: TIERS_2, service_charge: 0, tax_rate: 0.2 },
        rows: [makeRow()],
      }),
    );
    const cols = parseLines(csv)[1].split(",");
    expect(cols[17]).toBe("44545"); // taxable @ 10% not 20%
    expect(cols[18]).toBe("4455"); // VAT @ 10% not 20%
    // Sanity: NOT the value that would result from tax_rate=0.20
    expect(cols[18]).not.toBe("8167");
  });
});

describe("buildBillingPeriodCsv — RFC 4180 quoting", () => {
  it('special characters in name: O\'Brien, Inc. "Trading" → properly quoted with escaped double-quotes', () => {
    const tricky = makeRow({
      household: {
        ...makeRow().household,
        display_name: 'O\'Brien, Inc. "Trading"',
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [tricky] }));
    // The Household column is index 2.
    const lines = parseLines(csv);
    // We cannot naively split on comma because the cell is quoted.
    // Assert by raw substring.
    expect(lines[1]).toContain('"O\'Brien, Inc. ""Trading"""');
  });

  it("newline inside an address is quoted", () => {
    const withNewline = makeRow({
      household: {
        ...makeRow().household,
        address_line1: "Line1\nWith newline",
        unit_label: null,
        address_line2: null,
        address_city: null,
        address_country: null,
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [withNewline] }));
    expect(csv).toContain('"Line1\nWith newline"');
  });
});

describe("buildBillingPeriodCsv — null fields", () => {
  it("null account_number, meter_serial, paid_at → empty cells (NOT 'null')", () => {
    const nullRow = makeRow({
      household: {
        ...makeRow().household,
        account_number: null,
        meter_serial: null,
        primary_phone: null,
      },
      device: null,
      lineItem: {
        ...makeRow().lineItem,
        invoice_number: null,
        paid_at: null,
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [nullRow] }));
    expect(csv).not.toMatch(/\bnull\b/);
    expect(csv).not.toMatch(/\bundefined\b/);
    const cols = parseLines(csv)[1].split(",");
    expect(cols[0]).toBe(""); // invoice number
    expect(cols[3]).toBe(""); // account number
    expect(cols[4]).toBe(""); // meter ID
    expect(cols[8]).toBe(""); // phone
  });
});

describe("buildBillingPeriodCsv — Address composition", () => {
  it("missing line2 → 4 fields joined with single comma, no double comma", () => {
    const row = makeRow({
      household: {
        ...makeRow().household,
        unit_label: "Unit 7",
        address_line1: "12 Main Rd",
        address_line2: null,
        address_city: "Kampala",
        address_country: "Uganda",
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [row] }));
    // Address contains commas → it will be quoted in the cell. Check the
    // raw quoted address substring.
    expect(csv).toContain('"Unit 7, 12 Main Rd, Kampala, Uganda"');
  });

  it("all 5 address fields null → empty Address cell", () => {
    const row = makeRow({
      household: {
        ...makeRow().household,
        unit_label: null,
        address_line1: null,
        address_line2: null,
        address_city: null,
        address_country: null,
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [row] }));
    const cols = parseLines(csv)[1].split(",");
    expect(cols[7]).toBe(""); // Address index
  });

  it("blank-only address fields (whitespace) are filtered out", () => {
    const row = makeRow({
      household: {
        ...makeRow().household,
        unit_label: "   ",
        address_line1: "12 Main",
        address_line2: null,
        address_city: "Kampala",
        address_country: null,
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [row] }));
    // Two fields → comma-joined, will be quoted because contains comma.
    expect(csv).toContain('"12 Main, Kampala"');
  });
});

describe("buildBillingPeriodCsv — payment-status title case", () => {
  it.each([
    ["unpaid", "Unpaid"],
    ["paid", "Paid"],
    ["failed", "Failed"],
    ["refunded", "Refunded"],
    ["link_generated", "Link Generated"],
  ])("%s → %s", (input, expected) => {
    const row = makeRow({
      lineItem: { ...makeRow().lineItem, payment_status: input },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [row] }));
    // Payment Status is the 2nd-to-last column.
    const cols = parseLines(csv)[1].split(",");
    expect(cols[cols.length - 2]).toBe(expected);
  });
});

describe("buildBillingPeriodCsv — sort stability", () => {
  it("sorts by display_name ascending", () => {
    const rows = [
      makeRow({
        household: { ...makeRow().household, display_name: "Charlie" },
      }),
      makeRow({
        household: { ...makeRow().household, display_name: "Alice" },
      }),
      makeRow({
        household: { ...makeRow().household, display_name: "Bob" },
      }),
    ];
    const csv = buildBillingPeriodCsv(makeInput({ rows }));
    const lines = parseLines(csv);
    // Household column is index 2. We can grab it from each data row
    // by splitting; none of these names have commas.
    const names = lines.slice(1).map((l) => l.split(",")[2]);
    expect(names).toEqual(["Alice", "Bob", "Charlie"]);
  });

  it("identical display_name → secondary sort by lineItem.id ASC; re-running produces byte-identical output", () => {
    const rows = [
      makeRow({
        household: { ...makeRow().household, display_name: "Same" },
        lineItem: {
          ...makeRow().lineItem,
          id: "00000000-0000-0000-0000-000000000002",
          invoice_number: "INV-002",
        },
      }),
      makeRow({
        household: { ...makeRow().household, display_name: "Same" },
        lineItem: {
          ...makeRow().lineItem,
          id: "00000000-0000-0000-0000-000000000001",
          invoice_number: "INV-001",
        },
      }),
    ];
    const csv1 = buildBillingPeriodCsv(makeInput({ rows }));
    // Shuffle the input array; output must be byte-identical.
    const csv2 = buildBillingPeriodCsv(makeInput({ rows: [...rows].reverse() }));
    expect(csv2).toBe(csv1);
    // The row whose lineItem.id sorts first (…0001 → INV-001) appears
    // before the …0002 row regardless of input order.
    const lines = parseLines(csv1);
    expect(lines[1].split(",")[0]).toBe("INV-001");
    expect(lines[2].split(",")[0]).toBe("INV-002");
  });
});

describe("sanitizeFilenameSegment", () => {
  it.each([
    ["Sezibwa", "sezibwa"],
    [
      "Kisakye (Test with OpenEMS Integrated)",
      "kisakye-test-with-openems-integrated",
    ],
    ["NFE — Pilot #1", "nfe-pilot-1"],
    ["   trim me   ", "trim-me"],
  ])("%s → %s", (input, expected) => {
    expect(sanitizeFilenameSegment(input)).toBe(expected);
  });
});

describe("buildCsvFilename", () => {
  it("emits <slug>-billing-period-<start>-to-<end>.csv", () => {
    expect(
      buildCsvFilename({
        microgridName: "Sezibwa",
        startDate: "2026-04-01",
        endDate: "2026-04-30",
      }),
    ).toBe("sezibwa-billing-period-2026-04-01-to-2026-04-30.csv");
  });
});
