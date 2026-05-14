/**
 * csv-export.test.ts — pure-function tests for #229 / #232 CSV serializer.
 *
 * The helper is fully data-driven; these tests cover the AC-spec'd
 * invariants:
 *   - 19-column base header (+ 2 per tier) — `OpenEMS Meter ID`
 *     (renamed) at index 4, `Meter Serial` (new) at index 5 (#232).
 *   - Per-row VAT/service/subtotal derivation from
 *     `community.invoice_config.tax.rate_pct` (NOT `rateSchedule.tax_rate`).
 *   - Tier column lookup by `label`, not index (re-ordered breakdowns
 *     still align).
 *   - Address composition mirrors the PDF's 5-field filter+join.
 *   - BOM byte sequence + CRLF line endings + RFC 4180 quoting.
 *   - Sort stability (display_name asc, line-item id asc secondary).
 *   - Special characters (commas, quotes, newlines) are properly escaped.
 *   - Filename sanitization helper edge cases.
 *   - Display-side rounding of float-dust via `roundKwh`/`roundAmount`
 *     (#232), with NULL-passthrough preserved.
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
  it("emits 19 fixed columns + 2 per tier (4-tier microgrid → 27 columns)", () => {
    // #232: base columns shift from 18 → 19 (Meter Serial inserted at
    // index 5, after the renamed `OpenEMS Meter ID` at index 4).
    const csv = buildBillingPeriodCsv(
      makeInput({ rateSchedule: { tiers: TIERS_4, service_charge: 0, tax_rate: 0 } }),
    );
    const lines = parseLines(csv);
    const headerCols = lines[0].split(",");
    expect(headerCols.length).toBe(19 + 8);
    expect(headerCols[0]).toBe("Invoice Number");
    expect(headerCols[1]).toBe("Issue Date");
    expect(headerCols[2]).toBe("Household");
    expect(headerCols[3]).toBe("Account Number");
    expect(headerCols[4]).toBe("OpenEMS Meter ID");
    expect(headerCols[5]).toBe("Meter Serial");
    expect(headerCols[6]).toBe("Meter Type");
    expect(headerCols[8]).toBe("Address");
  });

  it("2-tier microgrid → 19 + 4 = 23 columns", () => {
    const csv = buildBillingPeriodCsv(makeInput());
    const cols = parseLines(csv)[0].split(",");
    expect(cols.length).toBe(19 + 4);
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
    // Tier columns start at index 13 (#232: shifted +1 from 12 due to
    // Meter Serial insertion at index 5). T1 kWh = 25, T1 UGX = 12500,
    // T2/T3/T4 kWh + UGX should be empty strings.
    expect(dataCols[13]).toBe("25");
    expect(dataCols[14]).toBe("12500");
    expect(dataCols[15]).toBe("");
    expect(dataCols[16]).toBe("");
    expect(dataCols[17]).toBe("");
    expect(dataCols[18]).toBe("");
    expect(dataCols[19]).toBe("");
    expect(dataCols[20]).toBe("");
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
    // Tier block starts at index 13 in #232's layout.
    for (let i = 13; i < 13 + 8; i++) {
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
    // #232: Column 13 = Tier 1 kWh, 14 = Tier 1 UGX, 15 = Tier 2 kWh, 16 = Tier 2 UGX
    expect(cols[13]).toBe("50");
    expect(cols[14]).toBe("25000");
    expect(cols[15]).toBe("30");
    expect(cols[16]).toBe("24000");
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
    // #232: Header order, after 4 tier cols: Service / Taxable / VAT / Total
    // base cols 0-12 + 4 tier cols = first non-tier index is 17
    // 17=Service Charge, 18=Taxable Subtotal, 19=VAT, 20=Total
    expect(cols[17]).toBe("0"); // service charge
    expect(cols[18]).toBe("41525"); // taxable subtotal
    expect(cols[19]).toBe("7475"); // VAT
    expect(cols[20]).toBe("49000"); // total
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
    expect(cols[17]).toBe("5000"); // service charge (#232: shifted +1)
    expect(cols[18]).toBe("54000"); // taxable subtotal = energy + service
    expect(cols[19]).toBe(""); // VAT empty (not zero)
  });

  it("VAT rate_pct=0 → VAT cell EMPTY (treated as disabled)", () => {
    const csv = buildBillingPeriodCsv(
      makeInput({
        invoiceConfig: { tax: { show_section: true, rate_pct: 0 } },
        rows: [makeRow()],
      }),
    );
    const cols = parseLines(csv)[1].split(",");
    expect(cols[19]).toBe("");
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
    expect(cols[18]).toBe("44545"); // taxable @ 10% not 20% (#232: shifted +1)
    expect(cols[19]).toBe("4455"); // VAT @ 10% not 20%
    // Sanity: NOT the value that would result from tax_rate=0.20
    expect(cols[19]).not.toBe("8167");
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
    expect(cols[4]).toBe(""); // OpenEMS Meter ID
    expect(cols[5]).toBe(""); // Meter Serial (#232: new column, NULL → empty cell, NOT "null")
    expect(cols[9]).toBe(""); // phone (#232: shifted +1 from index 8)
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
    expect(cols[8]).toBe(""); // Address index (#232: shifted +1 from 7)
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

// ── #232: column rename + Meter Serial + display-side rounding ───────────────

describe("buildBillingPeriodCsv — #232 OpenEMS Meter ID rename + Meter Serial column", () => {
  it("renames the meter-ID header from 'Meter ID' to 'OpenEMS Meter ID'", () => {
    const csv = buildBillingPeriodCsv(makeInput());
    const header = parseLines(csv)[0].split(",");
    expect(header).toContain("OpenEMS Meter ID");
    expect(header).not.toContain("Meter ID");
  });

  it("inserts 'Meter Serial' immediately after 'OpenEMS Meter ID'", () => {
    const csv = buildBillingPeriodCsv(makeInput());
    const header = parseLines(csv)[0].split(",");
    const meterIdIdx = header.indexOf("OpenEMS Meter ID");
    expect(meterIdIdx).toBe(4);
    expect(header[meterIdIdx + 1]).toBe("Meter Serial");
  });

  it("non-null meter_serial flows to data-row column index 5", () => {
    const row = makeRow({
      household: { ...makeRow().household, meter_serial: "MS-001" },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [row] }));
    const cols = parseLines(csv)[1].split(",");
    expect(cols[5]).toBe("MS-001");
  });

  it("null meter_serial → empty cell at index 5 (NOT 'null')", () => {
    const row = makeRow({
      household: { ...makeRow().household, meter_serial: null },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [row] }));
    const cols = parseLines(csv)[1].split(",");
    expect(cols[5]).toBe("");
    expect(csv).not.toMatch(/\bnull\b/);
  });
});

describe("buildBillingPeriodCsv — #232 display-side rounding masks float-dust", () => {
  it("dusty Tier 2 / Usage / Total stored values serialize clean (Arthur / Peter fixtures)", () => {
    // Composite fixture mirroring the dust patterns from the issue.
    const dustyRow = makeRow({
      household: { ...makeRow().household, display_name: "Dusty Row" },
      lineItem: {
        ...makeRow().lineItem,
        start_kwh: 83.57,
        end_kwh: 261.92,
        usage_kwh: 178.35000000000002,
        tier_breakdown: [
          { label: "Tier 1", kwh: 50, amount: 25000 },
          // Arthur's dust: tiny non-zero kWh + sub-integer UGX
          { label: "Tier 2", kwh: 0.11700000000000088, amount: 88.47540000000068 },
        ],
        total_amount: 10807.000972000002,
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [dustyRow] }));
    const cols = parseLines(csv)[1].split(",");

    // Usage kWh @ index 12 (#232: shifted +1 from 11) — roundKwh emits
    // raw `String(178.35)` with no trailing-zero pad.
    expect(cols[12]).toBe("178.35");

    // Tier 1 @ indices 13/14 (clean inputs — no padding).
    expect(cols[13]).toBe("50");
    expect(cols[14]).toBe("25000");

    // Tier 2 @ indices 15/16 — dusty `0.117…088` rounds to `0.117`;
    // dusty `88.4754…068` rounds to `88` (UGX is integer).
    expect(cols[15]).toBe("0.117");
    expect(cols[16]).toBe("88");

    // Total @ index 20 (#232: shifted +1 from 19) — `10807.000972…`
    // rounds to integer `10807`.
    expect(cols[20]).toBe("10807");
  });

  it("ANTI-TEST (idempotency): already-clean inputs do NOT pick up toFixed-style trailing zeros", () => {
    // `roundKwh(50) === 50` → `csvCell(50) === "50"` (NOT "50.000")
    // `roundAmount(25000) === 25000` → `csvCell(25000) === "25000"`
    const cleanRow = makeRow({
      lineItem: {
        ...makeRow().lineItem,
        start_kwh: 100,
        end_kwh: 200,
        usage_kwh: 100,
        tier_breakdown: [{ label: "Tier 1", kwh: 50, amount: 25000 }],
        total_amount: 25000,
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [cleanRow] }));
    const cols = parseLines(csv)[1].split(",");
    expect(cols[10]).toBe("100"); // Begin kWh — NOT "100.000"
    expect(cols[11]).toBe("200"); // End kWh
    expect(cols[12]).toBe("100"); // Usage kWh
    expect(cols[13]).toBe("50"); // Tier 1 kWh — NOT "50.000"
    expect(cols[14]).toBe("25000"); // Tier 1 UGX
    expect(cols[18]).toBe("25000"); // Taxable Subtotal
    expect(cols[20]).toBe("25000"); // Total
  });

  it("NULL passthrough: start_kwh=null serializes as empty cell, NOT '0'", () => {
    // The dangerous path: `roundKwh(null) === Math.round(null * 1000) / 1000 === 0`.
    // The serializer's null-guard ternary preserves the empty-cell
    // contract (NULL means "no reading taken", not "zero kWh").
    const nullKwhRow = makeRow({
      lineItem: {
        ...makeRow().lineItem,
        start_kwh: null,
        end_kwh: null,
        usage_kwh: null,
      },
    });
    const csv = buildBillingPeriodCsv(makeInput({ rows: [nullKwhRow] }));
    const cols = parseLines(csv)[1].split(",");
    // Begin/End/Usage at indices 10/11/12 (#232).
    expect(cols[10]).toBe("");
    expect(cols[11]).toBe("");
    expect(cols[12]).toBe("");
  });

  it("service charge with float-dust rounds once at initialization", () => {
    // `service_charge = 4999.999999` should serialize as `"5000"` and
    // also propagate cleanly into the taxable subtotal.
    const csv = buildBillingPeriodCsv(
      makeInput({
        invoiceConfig: { tax: { show_section: false, rate_pct: 0 } },
        rateSchedule: {
          tiers: TIERS_2,
          service_charge: 4999.999999,
          tax_rate: 0,
        },
        rows: [makeRow()],
      }),
    );
    const cols = parseLines(csv)[1].split(",");
    expect(cols[17]).toBe("5000"); // service charge — rounded
    // energy = 25000 + 24000 = 49000, +service 5000 = 54000.
    expect(cols[18]).toBe("54000");
  });
});
