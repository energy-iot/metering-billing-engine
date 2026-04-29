/**
 * invoice-number.test.ts — unit tests for `formatInvoiceNumber()`.
 *
 * Pins the AC8 boundary cases enumerated in #202 R5:
 *   - year 2019 ✗, 2020 ✓, 2200 ✓, 2201 ✗
 *   - counter 0 ✗, 1 ✓, 99999 ✓, 100000 ✗
 *   - prefix invalid (empty / 1-char / 9-char / lowercase / hyphen)
 *   - zero-padding pinned at 5 digits ("00001", "00421", "99999")
 *
 * The bounds in this helper, the `invoice_counters.year` CHECK, the plpgsql
 * guard inside `fn_next_invoice_number`, AND the
 * `billing_line_items.invoice_number` CHECK regex are all inclusive on both
 * ends. Divergence is a defect.
 */

import { describe, it, expect } from "vitest";

import { formatInvoiceNumber } from "../invoice-number";

describe("formatInvoiceNumber", () => {
  // ── Happy path ──────────────────────────────────────────────────────────
  it("formats a typical 5-digit-padded invoice number", () => {
    expect(formatInvoiceNumber("NFE", 2026, 421)).toBe("NFE-2026-00421");
  });

  it("formats counter 1 as 5-digit padded 00001", () => {
    expect(formatInvoiceNumber("NFE", 2026, 1)).toBe("NFE-2026-00001");
  });

  it("formats counter 99999 as 99999 (no truncation)", () => {
    expect(formatInvoiceNumber("NFE", 2026, 99999)).toBe("NFE-2026-99999");
  });

  it("accepts a 2-char prefix at the lower bound", () => {
    expect(formatInvoiceNumber("AB", 2026, 7)).toBe("AB-2026-00007");
  });

  it("accepts an 8-char prefix at the upper bound", () => {
    expect(formatInvoiceNumber("ACME0123", 2026, 7)).toBe(
      "ACME0123-2026-00007",
    );
  });

  it("accepts an all-digits prefix", () => {
    expect(formatInvoiceNumber("12", 2100, 5)).toBe("12-2100-00005");
  });

  // ── Year boundaries ─────────────────────────────────────────────────────
  it("accepts year 2020 (lower inclusive bound)", () => {
    expect(formatInvoiceNumber("NFE", 2020, 1)).toBe("NFE-2020-00001");
  });

  it("accepts year 2200 (upper inclusive bound)", () => {
    expect(formatInvoiceNumber("NFE", 2200, 1)).toBe("NFE-2200-00001");
  });

  it("rejects year 2019 (one below lower bound)", () => {
    expect(() => formatInvoiceNumber("NFE", 2019, 1)).toThrow(/year/);
  });

  it("rejects year 2201 (one above upper bound)", () => {
    expect(() => formatInvoiceNumber("NFE", 2201, 1)).toThrow(/year/);
  });

  it("rejects non-integer year", () => {
    expect(() => formatInvoiceNumber("NFE", 2025.5, 1)).toThrow(/year/);
  });

  // ── Counter boundaries ──────────────────────────────────────────────────
  it("rejects counter 0 (one below lower bound)", () => {
    expect(() => formatInvoiceNumber("NFE", 2026, 0)).toThrow(/counter/);
  });

  it("rejects counter 100000 (one above upper bound)", () => {
    expect(() => formatInvoiceNumber("NFE", 2026, 100000)).toThrow(/counter/);
  });

  it("rejects negative counter", () => {
    expect(() => formatInvoiceNumber("NFE", 2026, -1)).toThrow(/counter/);
  });

  it("rejects non-integer counter", () => {
    expect(() => formatInvoiceNumber("NFE", 2026, 1.5)).toThrow(/counter/);
  });

  // ── Prefix validation ───────────────────────────────────────────────────
  it("rejects empty prefix", () => {
    expect(() => formatInvoiceNumber("", 2026, 1)).toThrow(/prefix/);
  });

  it("rejects 1-char prefix (one below lower bound)", () => {
    expect(() => formatInvoiceNumber("A", 2026, 1)).toThrow(/prefix/);
  });

  it("rejects 9-char prefix (one above upper bound)", () => {
    expect(() => formatInvoiceNumber("ACME01234", 2026, 1)).toThrow(/prefix/);
  });

  it("rejects lowercase prefix", () => {
    expect(() => formatInvoiceNumber("nfe", 2026, 1)).toThrow(/prefix/);
  });

  it("rejects prefix with hyphen", () => {
    expect(() => formatInvoiceNumber("NF-E", 2026, 1)).toThrow(/prefix/);
  });

  it("rejects prefix with whitespace", () => {
    expect(() => formatInvoiceNumber("NF E", 2026, 1)).toThrow(/prefix/);
  });
});
