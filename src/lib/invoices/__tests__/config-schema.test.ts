/**
 * config-schema.test.ts — Zod validators for the invoice JSONB shape.
 *
 * Pins the AC8 enumeration in #202:
 *   - parseInvoiceConfig: valid full, valid empty, invalid hex color, invalid
 *     due_days, oversized arrays, tax cross-field rule (show: true with rate 0
 *     fails; show: false with rate 0 passes).
 *   - parseInvoicePrefix: valid 2-char, valid 8-char, invalid empty, invalid
 *     1-char, invalid 9-char, invalid lowercase, invalid hyphen.
 *   - parseInvoiceUpdate: combined wrapper.
 */

import { describe, it, expect } from "vitest";

import {
  parseInvoiceConfig,
  parseInvoicePrefix,
  parseInvoiceUpdate,
} from "../config-schema";

describe("parseInvoiceConfig", () => {
  it("accepts an empty object (the default JSONB shape)", () => {
    expect(parseInvoiceConfig({})).toEqual({});
  });

  it("accepts a full, well-formed invoice_config", () => {
    const input = {
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
        logo_storage_path: null,
        tagline: "Customer Energy Bill",
        primary_color: "#163a5f",
        accent_color: "#2f7d32",
        whatsapp_number: null,
        document_title: "Invoice",
      },
      payment: { due_days_after_issue: 8 },
      tax: {
        show_section: true,
        category_label: "VAT @ 18%",
        rate_pct: 18,
      },
      notices: {
        vat_text: null,
        payment_instructions_text: null,
        signature_disclaimer: null,
      },
    };
    expect(parseInvoiceConfig(input)).toBeDefined();
  });

  it("rejects unknown top-level keys (strict)", () => {
    expect(() =>
      parseInvoiceConfig({ unknown_key: 42 }),
    ).toThrow();
  });

  // ── Seller block ─────────────────────────────────────────────────────────
  it("requires seller.legal_name when seller is present", () => {
    expect(() =>
      parseInvoiceConfig({ seller: { trade_name: "x" } }),
    ).toThrow();
  });

  it("admits a non-empty legal_name when seller is present", () => {
    expect(() =>
      parseInvoiceConfig({ seller: { legal_name: "Acme" } }),
    ).not.toThrow();
  });

  // ── Branding ─────────────────────────────────────────────────────────────
  it("rejects invalid hex color on branding.primary_color", () => {
    expect(() =>
      parseInvoiceConfig({ branding: { primary_color: "navy" } }),
    ).toThrow();
  });

  it("rejects 4-digit hex color", () => {
    expect(() =>
      parseInvoiceConfig({ branding: { primary_color: "#abc" } }),
    ).toThrow();
  });

  it("accepts 6-digit hex color (lower or upper case)", () => {
    expect(() =>
      parseInvoiceConfig({ branding: { primary_color: "#163a5f" } }),
    ).not.toThrow();
    expect(() =>
      parseInvoiceConfig({ branding: { accent_color: "#2F7D32" } }),
    ).not.toThrow();
  });

  // ── Payment ──────────────────────────────────────────────────────────────
  it("rejects non-integer due_days_after_issue", () => {
    expect(() =>
      parseInvoiceConfig({ payment: { due_days_after_issue: 8.5 } }),
    ).toThrow();
  });

  it("rejects due_days_after_issue below 1", () => {
    expect(() =>
      parseInvoiceConfig({ payment: { due_days_after_issue: 0 } }),
    ).toThrow();
  });

  it("rejects due_days_after_issue above 60", () => {
    expect(() =>
      parseInvoiceConfig({ payment: { due_days_after_issue: 61 } }),
    ).toThrow();
  });

  // ── Tax cross-field rule ─────────────────────────────────────────────────
  it("rejects tax.show_section: true with tax.rate_pct: 0 (renders nonsense)", () => {
    expect(() =>
      parseInvoiceConfig({
        tax: { show_section: true, rate_pct: 0 },
      }),
    ).toThrow();
  });

  it("accepts tax.show_section: false with tax.rate_pct: 0", () => {
    expect(() =>
      parseInvoiceConfig({
        tax: { show_section: false, rate_pct: 0 },
      }),
    ).not.toThrow();
  });

  it("accepts tax.show_section: true with positive tax.rate_pct", () => {
    expect(() =>
      parseInvoiceConfig({
        tax: { show_section: true, rate_pct: 18 },
      }),
    ).not.toThrow();
  });

  it("rejects tax.rate_pct above 30", () => {
    expect(() =>
      parseInvoiceConfig({
        tax: { show_section: true, rate_pct: 31 },
      }),
    ).toThrow();
  });

  // ── Array bounds ─────────────────────────────────────────────────────────
  it("rejects more than 6 address_lines", () => {
    expect(() =>
      parseInvoiceConfig({
        seller: {
          legal_name: "Acme",
          address_lines: ["1", "2", "3", "4", "5", "6", "7"],
        },
      }),
    ).toThrow();
  });

  it("rejects more than 4 tax_ids", () => {
    expect(() =>
      parseInvoiceConfig({
        seller: {
          legal_name: "Acme",
          tax_ids: [
            { label: "A", value: "1" },
            { label: "B", value: "2" },
            { label: "C", value: "3" },
            { label: "D", value: "4" },
            { label: "E", value: "5" },
          ],
        },
      }),
    ).toThrow();
  });
});

describe("parseInvoicePrefix", () => {
  it("accepts a 2-char uppercase prefix (lower bound)", () => {
    expect(parseInvoicePrefix("AB")).toBe("AB");
  });

  it("accepts an 8-char uppercase alphanumeric prefix (upper bound)", () => {
    expect(parseInvoicePrefix("ACME0123")).toBe("ACME0123");
  });

  it("accepts an all-digits prefix", () => {
    expect(parseInvoicePrefix("12")).toBe("12");
  });

  it("rejects an empty string", () => {
    expect(() => parseInvoicePrefix("")).toThrow();
  });

  it("rejects a 1-char prefix (one below lower bound)", () => {
    expect(() => parseInvoicePrefix("A")).toThrow();
  });

  it("rejects a 9-char prefix (one above upper bound)", () => {
    expect(() => parseInvoicePrefix("ACME01234")).toThrow();
  });

  it("rejects a lowercase prefix", () => {
    expect(() => parseInvoicePrefix("nfe")).toThrow();
  });

  it("rejects a prefix with a hyphen", () => {
    expect(() => parseInvoicePrefix("NF-E")).toThrow();
  });

  it("rejects a prefix with whitespace", () => {
    expect(() => parseInvoicePrefix("NF E")).toThrow();
  });

  it("rejects a non-string input", () => {
    expect(() => parseInvoicePrefix(42)).toThrow();
  });
});

describe("parseInvoiceUpdate", () => {
  it("accepts a well-formed combined body", () => {
    expect(
      parseInvoiceUpdate({
        invoice_prefix: "NFE",
        invoice_config: {
          seller: { legal_name: "Acme" },
        },
      }),
    ).toBeDefined();
  });

  it("rejects when invoice_prefix is missing", () => {
    expect(() =>
      parseInvoiceUpdate({
        invoice_config: {},
      }),
    ).toThrow();
  });

  it("rejects when invoice_config is missing", () => {
    expect(() =>
      parseInvoiceUpdate({
        invoice_prefix: "NFE",
      }),
    ).toThrow();
  });

  it("rejects when invoice_prefix is invalid", () => {
    expect(() =>
      parseInvoiceUpdate({
        invoice_prefix: "nfe",
        invoice_config: {},
      }),
    ).toThrow();
  });

  it("rejects when invoice_config is invalid (cascades from inner schema)", () => {
    expect(() =>
      parseInvoiceUpdate({
        invoice_prefix: "NFE",
        invoice_config: {
          tax: { show_section: true, rate_pct: 0 },
        },
      }),
    ).toThrow();
  });
});
