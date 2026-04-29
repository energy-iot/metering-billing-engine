/**
 * config-schema.ts — Zod validators for the per-community invoice JSONB.
 *
 * Mirrors the JSONB shape spec'd in mbe-docs PLAN.md § "Data model". Reused
 * by:
 *   - PDF2's PATCH /api/communities/[id]/invoice-config route (input validation
 *     before persisting).
 *   - PDF1b's renderer (defense-in-depth: corrupt JSONB won't 500 the renderer).
 *   - The `parseInvoicePrefix` validator pairs with the `communities.invoice_prefix`
 *     column CHECK in 00033 — same regex on both sides.
 *
 * Exports:
 *   - parseInvoiceConfig(input)  → InvoiceConfig (throws on invalid input)
 *   - parseInvoicePrefix(input)  → string       (throws on invalid input)
 *   - parseInvoiceUpdate(input)  → { invoice_prefix, invoice_config }
 *
 * Validation choices documented at field site. Cross-field rule for tax
 * (R1 reversed in R5): `tax.show_section === false OR tax.rate_pct > 0`. You
 * cannot have "show: true with rate 0" (renders nonsense); the inverse
 * "show: false, rate: 0" is fine.
 */

import { z } from "zod";

// ── Field validators ─────────────────────────────────────────────────────────

/**
 * Invoice-prefix regex. Same source-of-truth as the `invoice_prefix` column
 * CHECK in supabase/migrations/00033_pdf_invoices_schema.sql AND the
 * `formatInvoiceNumber` helper. A divergence between the three is a defect.
 */
export const INVOICE_PREFIX_RE = /^[A-Z0-9]{2,8}$/;

/** Hex color in `#RRGGBB` form (case-insensitive on the digits). */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

const HexColor = z.string().regex(HEX_COLOR_RE, {
  message: "must be a 7-character hex color (e.g. #163a5f)",
});

/**
 * Format-only email validator; rejects whitespace, requires `@` and `.`. Used
 * by `seller.contact_email` (community invoice config). Deliverability is
 * verified out-of-band, never at this boundary. Do NOT tighten to RFC 5322 —
 * the format-only intent is deliberate.
 */
const EmailFormat = z.string().regex(/^[^@\s]+@[^@\s]+\.[^@\s]+$/, {
  message: "must look like an email address (no whitespace, contains @ and .)",
});

const TaxId = z.object({
  label: z.string().min(1).max(20),
  value: z.string().min(1).max(64),
});

// ── Sub-objects ──────────────────────────────────────────────────────────────

/**
 * `seller` block. When the key is PRESENT, `legal_name` is required. When the
 * key is ABSENT entirely (the default `'{}'` shape post-migration), the
 * validator passes; PDF1b's renderer falls back to `organization.name` for
 * the legal name display.
 */
const Seller = z.object({
  legal_name: z.string().min(1).max(200),
  trade_name: z.string().max(200).optional(),
  tax_ids: z.array(TaxId).max(4).optional(),
  address_lines: z.array(z.string().max(200)).max(6).optional(),
  contact_email: EmailFormat.optional(),
  contact_phone: z.string().max(40).optional(),
});

const Branding = z
  .object({
    logo_storage_path: z.string().max(500).nullable().optional(),
    tagline: z.string().max(200).optional(),
    primary_color: HexColor.optional(),
    accent_color: HexColor.optional(),
    whatsapp_number: z.string().max(40).nullable().optional(),
    document_title: z.string().max(40).optional(),
  })
  .optional();

const Payment = z
  .object({
    due_days_after_issue: z
      .number()
      .int({ message: "must be an integer" })
      .min(1)
      .max(60),
  })
  .optional();

/**
 * `tax` block. Cross-field rule: `tax.show_section === false OR tax.rate_pct > 0`.
 *
 *   - show: true,  rate > 0   → OK (the canonical "show VAT" case)
 *   - show: true,  rate === 0 → REJECTED (renders nonsense)
 *   - show: false, rate === 0 → OK (no VAT, hidden)
 *   - show: false, rate > 0   → OK (configured but hidden — admin's choice)
 */
const Tax = z
  .object({
    show_section: z.boolean().optional(),
    category_label: z.string().max(40).optional(),
    rate_pct: z
      .number()
      .int({ message: "must be an integer" })
      .min(0)
      .max(30)
      .optional(),
  })
  .refine(
    (t) => t.show_section === false || (t.rate_pct ?? 0) > 0,
    {
      message:
        "tax.show_section can only be true when tax.rate_pct > 0 (cannot show a 0% VAT section)",
      path: ["rate_pct"],
    },
  )
  .optional();

const Notices = z
  .object({
    vat_text: z.string().max(1000).nullable().optional(),
    payment_instructions_text: z.string().max(1000).nullable().optional(),
    signature_disclaimer: z.string().max(500).nullable().optional(),
  })
  .optional();

// ── Top-level invoice_config ─────────────────────────────────────────────────

export const InvoiceConfigSchema = z
  .object({
    seller: Seller.optional(),
    branding: Branding,
    payment: Payment,
    tax: Tax,
    notices: Notices,
  })
  .strict();

export type InvoiceConfig = z.infer<typeof InvoiceConfigSchema>;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate `invoice_config` JSONB. Throws `z.ZodError` on invalid input.
 *
 * Empty object `{}` is valid (the column default). When the `seller` key is
 * present, `legal_name` is required.
 */
export function parseInvoiceConfig(input: unknown): InvoiceConfig {
  return InvoiceConfigSchema.parse(input);
}

/**
 * Validate an invoice prefix. Throws `z.ZodError` on invalid input.
 *
 * Same regex as the `communities.invoice_prefix` column CHECK in 00033.
 * Surfacing the validator client-side lets PDF2's PATCH route 400 with a
 * field-level error before round-tripping to Postgres CHECK.
 */
export function parseInvoicePrefix(input: unknown): string {
  const result = z
    .string()
    .regex(INVOICE_PREFIX_RE, {
      message:
        "Invoice prefix must be 2-8 uppercase letters or digits (e.g. NFE, ACME01).",
    })
    .parse(input);
  return result;
}

/**
 * Combined validator for PDF2's PATCH body. PDF2 imports this so the route
 * has a single import covering both fields.
 */
export const InvoiceUpdateSchema = z
  .object({
    invoice_prefix: z
      .string()
      .regex(INVOICE_PREFIX_RE, {
        message:
          "Invoice prefix must be 2-8 uppercase letters or digits (e.g. NFE, ACME01).",
      }),
    invoice_config: InvoiceConfigSchema,
  })
  .strict();

export type InvoiceUpdate = z.infer<typeof InvoiceUpdateSchema>;

export function parseInvoiceUpdate(input: unknown): InvoiceUpdate {
  return InvoiceUpdateSchema.parse(input);
}
