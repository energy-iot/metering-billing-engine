/**
 * invoice-number.ts — invoice number formatter.
 *
 * Format: `{prefix}-{YYYY}-{NNNNN}` (e.g. "NFE-2026-00421"). Per Aaron's
 * existing nomenclature; locked as D3 in mbe-docs PLAN.md.
 *
 * The bounds in this helper, the `invoice_counters.year` CHECK, the
 * plpgsql guard inside `fn_next_invoice_number`, AND the
 * `billing_line_items.invoice_number` CHECK regex are ALL inclusive on both
 * ends post-R5 (year 2020-2200, counter 1-99999). A divergence between any
 * of them is a defect.
 *
 * The 5-digit counter cap (99,999/community/year) is well above any realistic
 * MVP throughput; if a community ever exceeds it, the format AND every guard
 * above must change in lockstep.
 */

import { INVOICE_PREFIX_RE } from "./config-schema";

const MIN_YEAR = 2020;
const MAX_YEAR = 2200;
const MIN_COUNTER = 1;
const MAX_COUNTER = 99_999;

/**
 * Build the formatted invoice number string. Throws `Error` on invalid
 * input (caller is expected to have validated upstream — this is a
 * defense-in-depth layer that pins the column CHECK regex contract).
 */
export function formatInvoiceNumber(
  prefix: string,
  year: number,
  counter: number,
): string {
  if (typeof prefix !== "string" || !INVOICE_PREFIX_RE.test(prefix)) {
    throw new Error(
      `formatInvoiceNumber: invalid prefix ${JSON.stringify(prefix)} — must match ${INVOICE_PREFIX_RE.source}`,
    );
  }
  if (
    !Number.isInteger(year) ||
    year < MIN_YEAR ||
    year > MAX_YEAR
  ) {
    throw new Error(
      `formatInvoiceNumber: invalid year ${year} — must be integer in [${MIN_YEAR}, ${MAX_YEAR}]`,
    );
  }
  if (
    !Number.isInteger(counter) ||
    counter < MIN_COUNTER ||
    counter > MAX_COUNTER
  ) {
    throw new Error(
      `formatInvoiceNumber: invalid counter ${counter} — must be integer in [${MIN_COUNTER}, ${MAX_COUNTER}]`,
    );
  }

  return `${prefix}-${year}-${String(counter).padStart(5, "0")}`;
}

// Exported for tests + the SQL CHECK regex pinning.
export const INVOICE_NUMBER_BOUNDS = {
  MIN_YEAR,
  MAX_YEAR,
  MIN_COUNTER,
  MAX_COUNTER,
} as const;
