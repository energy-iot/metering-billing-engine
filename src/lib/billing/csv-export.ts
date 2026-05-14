/**
 * csv-export.ts — pure CSV serializer for billing-period exports (#229).
 *
 * Aaron's URA-filing workflow: download the CSV → open in Excel as an
 * intermediary → paste row-by-row into URA's online portal. The output
 * is therefore optimized for:
 *
 *   - RFC 4180 compliance (CRLF, double-quote escaping).
 *   - UTF-8 BOM (`0xEF 0xBB 0xBF`) so Excel for Mac / Windows detects
 *     UTF-8 without falling back to the system locale and mangling
 *     accents in household names.
 *   - Locale-neutral raw decimal values — operators' spreadsheets do the
 *     display formatting. We do NOT call `Intl.NumberFormat` or
 *     `toLocaleString`.
 *   - Per-tier column expansion (Tier 1 kWh, Tier 1 <CUR>, …) so URA's
 *     per-tier fields paste directly.
 *
 * Header columns mirror PDF1a/PDF1b semantics (`Invoice Number`,
 * `Issue Date`, `Meter Type`, composed `Address`) so a CSV row and a
 * PDF for the same line item are byte-consistent at the cell level.
 *
 * VAT derivation mirrors `src/lib/invoices/render.tsx:1226-1243` — the
 * VAT column is derived from `community.invoice_config.tax.rate_pct`
 * via the "VAT-from-total" formula. The `rate_schedules.tax_rate`
 * multiplier (informational on the input) is NOT used for column
 * derivation; PDFs and CSVs must agree on the same tax convention.
 *
 * Pure function — no I/O, no `Date.now()`, no DB access. All inputs are
 * explicit so the helper is fully unit-testable.
 */

import { roundAmount } from "./precision";

/** Per-row input to {@link buildBillingPeriodCsv}. */
export interface CsvExportRow {
  household: {
    display_name: string;
    account_number: string | null;
    meter_serial: string | null;
    meter_type: string;
    customer_type: string;
    unit_label: string | null;
    address_line1: string | null;
    address_line2: string | null;
    address_city: string | null;
    address_country: string | null;
    primary_phone: string | null;
  };
  device: { openems_component_id: string | null } | null;
  lineItem: {
    id: string;
    invoice_number: string | null;
    created_at: string;
    start_kwh: number | null;
    end_kwh: number | null;
    usage_kwh: number | null;
    tier_breakdown: Array<{ label: string; kwh: number; amount: number }>;
    total_amount: number;
    payment_status: string;
    paid_at: string | null;
  };
}

/** Aggregate input to {@link buildBillingPeriodCsv}. */
export interface CsvExportInput {
  microgrid: { name: string; currency: string };
  period: {
    id: string;
    start_date: string;
    end_date: string;
    status: string;
  };
  /**
   * Selected rate schedule (most-recent for the microgrid). `tiers`
   * drives per-tier column expansion; `service_charge` populates the
   * Service Charge column; `tax_rate` is INFORMATIONAL (the multiplier
   * baked into `total_amount` at write-time) and is intentionally NOT
   * used for CSV VAT derivation — see {@link CsvExportInput.invoiceConfig}.
   */
  rateSchedule: {
    tiers: Array<{
      label: string;
      min_kwh: number;
      max_kwh: number | null;
      rate_per_kwh: number;
    }>;
    service_charge: number;
    tax_rate: number;
  };
  /**
   * VAT/tax config from the community. `rate_pct` is a PERCENTAGE
   * (e.g. `18` for 18%, NOT the multiplier `0.18`). When
   * `show_section === false` OR `rate_pct === 0`, the VAT cell is
   * emitted as empty (distinguishing "tax exempt" from "tax = 0 on a
   * tiny bill"), and Taxable Subtotal = energy + service charge.
   */
  invoiceConfig: {
    tax: { show_section: boolean; rate_pct: number };
  };
  rows: CsvExportRow[];
}

/** Mapping from the lower-case enum value to the title-cased display label. */
const PAYMENT_STATUS_LABELS: Record<string, string> = {
  unpaid: "Unpaid",
  paid: "Paid",
  failed: "Failed",
  refunded: "Refunded",
  link_generated: "Link Generated",
};

/** RFC 4180 quoting: wrap in `"…"` if the cell contains any of `,`, `"`,
 * `\r`, `\n`; escape embedded `"` as `""`. */
function csvCell(value: unknown): string {
  if (value == null) return "";
  const s = typeof value === "string" ? value : String(value);
  if (s.length === 0) return "";
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Compose the service Address from the same 5 fields as the PDF renderer
 * (`render.tsx:665-674`): filter empty/blank, comma-join the rest. */
function composeAddress(h: CsvExportRow["household"]): string {
  return [
    h.unit_label,
    h.address_line1,
    h.address_line2,
    h.address_city,
    h.address_country,
  ]
    .map((s) => (s ?? "").trim())
    .filter((s) => s.length > 0)
    .join(", ");
}

/** Title-case a customer_type enum value (e.g. `residential` → `Residential`). */
function titleCaseCustomerType(s: string): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Issue Date is `created_at` rendered as ISO date `YYYY-MM-DD`. */
function isoDate(iso: string | null): string {
  if (!iso) return "";
  // ISO timestamps from Postgres: `YYYY-MM-DDTHH:MM:SS…` — take the date prefix.
  return iso.slice(0, 10);
}

/** Filename sanitization per AC: lowercase, non-alphanumerics → single
 * dash, strip leading/trailing dashes. */
export function sanitizeFilenameSegment(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Build the `Content-Disposition` filename for a CSV download.
 *
 *   `<sanitized-microgrid>-billing-period-<start>-to-<end>.csv`
 */
export function buildCsvFilename(input: {
  microgridName: string;
  startDate: string;
  endDate: string;
}): string {
  const slug = sanitizeFilenameSegment(input.microgridName);
  return `${slug}-billing-period-${input.startDate}-to-${input.endDate}.csv`;
}

/** UTF-8 BOM bytes (`0xEF 0xBB 0xBF`). */
export const UTF8_BOM = "﻿";

/**
 * Build the full CSV body for a billing-period export.
 *
 * Output contract:
 *   - Starts with the UTF-8 BOM character (`﻿`), which serializes
 *     to bytes `0xEF 0xBB 0xBF`.
 *   - One header row + N data rows separated by `\r\n` (RFC 4180).
 *   - Per-tier columns are expanded in `rateSchedule.tiers` order.
 *   - Rows are sorted by `household.display_name` (case-insensitive,
 *     locale-stable via `localeCompare`); ties broken by `lineItem.id`.
 *   - Empty rows array → header-only CSV.
 */
export function buildBillingPeriodCsv(input: CsvExportInput): string {
  const cur = input.microgrid.currency;
  const tiers = input.rateSchedule.tiers ?? [];
  const tax = input.invoiceConfig?.tax;
  const showTax =
    !!tax && tax.show_section !== false && (tax.rate_pct ?? 0) > 0;
  const taxRatePct = tax?.rate_pct ?? 0;
  const serviceCharge = input.rateSchedule.service_charge ?? 0;

  // ── Header ────────────────────────────────────────────────────────────────
  const header: string[] = [
    "Invoice Number",
    "Issue Date",
    "Household",
    "Account Number",
    "Meter ID",
    "Meter Type",
    "Customer Type",
    "Address",
    "Phone",
    "Begin kWh",
    "End kWh",
    "Usage kWh",
  ];
  for (const t of tiers) {
    header.push(`${t.label} kWh`);
    header.push(`${t.label} ${cur}`);
  }
  header.push(`Service Charge ${cur}`);
  header.push(`Taxable Subtotal ${cur}`);
  header.push(`VAT ${cur}`);
  header.push(`Total ${cur}`);
  header.push("Payment Status");
  header.push("Paid At");

  // ── Sort rows (stable secondary by line-item id) ──────────────────────────
  const sortedRows = [...input.rows].sort((a, b) => {
    const nameCmp = a.household.display_name.localeCompare(
      b.household.display_name,
    );
    if (nameCmp !== 0) return nameCmp;
    return a.lineItem.id.localeCompare(b.lineItem.id);
  });

  // ── Data rows ─────────────────────────────────────────────────────────────
  const dataRows: string[][] = sortedRows.map((row) => {
    const { household: h, device, lineItem: li } = row;

    // Tier lookup by label — handles tier_breakdown arrays that have
    // shifted order or omit unreached tiers entirely.
    const breakdownByLabel = new Map<
      string,
      { kwh: number; amount: number }
    >();
    for (const tb of li.tier_breakdown ?? []) {
      breakdownByLabel.set(tb.label, { kwh: tb.kwh, amount: tb.amount });
    }

    const tierCells: string[] = [];
    for (const t of tiers) {
      const hit = breakdownByLabel.get(t.label);
      if (hit === undefined) {
        // URA distinguishes blank from zero — emit empty cells for
        // unreached tiers, NOT "0".
        tierCells.push("");
        tierCells.push("");
      } else {
        tierCells.push(csvCell(hit.kwh));
        tierCells.push(csvCell(hit.amount));
      }
    }

    // Derive Taxable Subtotal + VAT to MATCH the PDF (see
    // `render.tsx:1226-1243`).
    const totalAmount = li.total_amount ?? 0;
    const energySubtotal = (li.tier_breakdown ?? []).reduce(
      (acc, tb) => acc + (tb.amount ?? 0),
      0,
    );
    const preTaxSubtotal = energySubtotal + serviceCharge;
    let taxableSubtotal: number;
    let vatCell: string;
    if (showTax) {
      const net = roundAmount(totalAmount / (1 + taxRatePct / 100));
      const vat = roundAmount(totalAmount - net);
      taxableSubtotal = net;
      vatCell = csvCell(vat);
    } else {
      taxableSubtotal = preTaxSubtotal;
      // VAT disabled — emit EMPTY (not zero) to distinguish "tax exempt"
      // from "tax = 0 on a tiny bill".
      vatCell = "";
    }

    const paymentLabel =
      PAYMENT_STATUS_LABELS[li.payment_status] ?? li.payment_status;

    return [
      csvCell(li.invoice_number),
      csvCell(isoDate(li.created_at)),
      csvCell(h.display_name),
      csvCell(h.account_number),
      csvCell(device?.openems_component_id ?? null),
      csvCell(h.meter_type),
      csvCell(titleCaseCustomerType(h.customer_type)),
      csvCell(composeAddress(h)),
      csvCell(h.primary_phone),
      csvCell(li.start_kwh),
      csvCell(li.end_kwh),
      csvCell(li.usage_kwh),
      ...tierCells,
      csvCell(serviceCharge),
      csvCell(taxableSubtotal),
      vatCell,
      csvCell(totalAmount),
      csvCell(paymentLabel),
      csvCell(isoDate(li.paid_at)),
    ];
  });

  // ── Assemble ──────────────────────────────────────────────────────────────
  const lines = [header.join(","), ...dataRows.map((r) => r.join(","))];
  // CRLF line endings per RFC 4180 §2.1; trailing CRLF to terminate the
  // last record (some Excel-on-Windows builds drop the last row without
  // it).
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}
