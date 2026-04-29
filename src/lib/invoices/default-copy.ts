/**
 * default-copy.ts — fallback notice strings for the consumer-facing PDF.
 *
 * Per #203 AC3: the renderer reads `invoice_config.notices.<key>` first and
 * falls back to these constants when the JSONB key is null/missing. PDF2's
 * Community Setup → Invoice form will surface these as placeholder values
 * so operators can see the default before overriding.
 *
 * Wording sourced from Aaron's NFE template
 * (`/Users/amalbet/Downloads/nfe_energy_bill_template.html`) so the default
 * matches what the first deployment expects to see.
 */

/**
 * Note rendered in the green "VAT Notice" card (totals row, left column).
 * The placeholder `{rate_pct}` is interpolated by the renderer with the
 * configured tax rate (e.g. "18%"). When the tax section is hidden, this
 * copy is not rendered at all.
 */
export const DEFAULT_VAT_TEXT =
  "All billable items on this invoice, including tiered energy charges and " +
  "the service charge, are subject to {rate_pct}% VAT. VAT is shown " +
  "separately below for transparency.";

/**
 * Footer Payment Information sub-note (rendered below the Pay Now button +
 * link). Hidden entirely when the Payment Information card itself is hidden
 * (community has no payment provider configured).
 */
export const DEFAULT_PAYMENT_INSTRUCTIONS_TEXT =
  "Use the button or link above to complete payment securely. Your invoice " +
  "reference should be tied to the payment link.";

/**
 * Single-line footer disclaimer in the Customer Support card. Visible on
 * every rendered bill regardless of payment-provider configuration.
 */
export const DEFAULT_SIGNATURE_DISCLAIMER =
  "This invoice is computer generated and valid without signature.";
