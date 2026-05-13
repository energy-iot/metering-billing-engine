/**
 * short-slug.ts (#223) — generator + mint helper for the customer-facing
 * `/p/<slug>` payment-link indirection.
 *
 * Why a slug? Aaron's 2026-05-04 NFE bills shipped with a 116-char Payment
 * Link rendered in the PDF (line-item UUID embedded in the path). The PDF
 * renderer hyphenates long words mid-domain ("ver-cel") and the URL overflows
 * the Payment Information card. New bills embed `/p/<6-8 char base62>` which
 * 302s through to the legacy `/api/billing-line-items/<uuid>/pay` route. The
 * legacy route stays forever — bills already in customer WhatsApp threads
 * reference the long form.
 *
 * Stability invariant: once minted, the slug is the row's permanent
 * indirection key. Regenerating a bill does NOT re-mint the slug
 * (contrast `buildOrderId(lineItemId)` in ensure-payment-link.ts:279, which
 * DOES mint fresh per call because Pesapal rejects merchant-reference reuse).
 * `fn_record_line_item_with_audit`'s DO UPDATE SET clause does NOT mention
 * `short_slug`, so re-generating a line item via runGenerationFor preserves
 * the slug.
 *
 * Concurrency: two concurrent /pdf renders against the same line item race
 * to mint. We use the UPDATE-NULL-guard + loser-path re-SELECT pattern,
 * mirroring `ensure-payment-link.ts:376-405` (#202). The UPDATE-NULL guard
 * resolves the slot race; the partial UNIQUE index on `short_slug` resolves
 * cross-row collisions (the rare case where two rows generate the same
 * candidate — at 6 chars base62 = 56.8B combos, p ≈ 1-in-billion, but we
 * retry on 23505 anyway to keep the contract correct).
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { PaymentError } from "./errors";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const SLUG_LEN = 6;
const PG_UNIQUE_VIOLATION = "23505";
// Max attempts on cross-row 23505 collisions. At 6-char base62 a single
// retry suffices in practice — 5 is paranoid but cheap (max ~5 round-trips
// on an essentially-impossible event).
const MAX_MINT_ATTEMPTS = 5;

// 256 % 62 = 8 leftover slots. To avoid modular bias, reject byte values
// 248..255 and re-sample. This keeps the distribution over the 62-char
// alphabet exactly uniform.
//
// 248 = floor(256 / 62) * 62 = 4 * 62 = 248. Equivalently:
// the largest multiple of 62 that fits in a uint8 is 248; any byte ≥ 248
// would map to one of the 0..7 alphabet slots more often than the rest,
// so we drop it.
const REJECT_THRESHOLD = 248;

/**
 * Generate a 6-char base62 slug from `crypto.randomBytes`.
 *
 * Algorithm: read bytes one at a time, reject ≥ REJECT_THRESHOLD (modular-
 * bias correction), map the rest to alphabet index `byte % 62`. Stops once
 * SLUG_LEN accepted bytes are collected. Average byte consumption per slug
 * is ~6 * (256/248) ≈ 6.2 bytes — a single 16-byte buffer is plenty for the
 * worst-case inner loop without re-allocation.
 *
 * Pure / synchronous — safe for hot-path code; takes no I/O.
 */
export function generateShortSlug(): string {
  // node:crypto is a built-in; lazy require avoids edge-runtime ambiguity if
  // this module is ever imported from a route that runs on edge.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");

  let out = "";
  // Pull bytes in chunks; refill if we burn through them due to rejection.
  let buf = crypto.randomBytes(16);
  let i = 0;
  while (out.length < SLUG_LEN) {
    if (i >= buf.length) {
      buf = crypto.randomBytes(16);
      i = 0;
    }
    const byte = buf[i++];
    if (byte >= REJECT_THRESHOLD) {
      continue; // modular-bias rejection
    }
    out += ALPHABET[byte % 62];
  }
  return out;
}

/**
 * Atomically claim a short slug for the given line item, or return the slug
 * a concurrent caller already claimed for the SAME row.
 *
 * Concurrency contract (mirrors `ensure-payment-link.ts:376-405`, the #202
 * cached-pesapal-URL pattern):
 *
 *   1. Generate a candidate via `generateShortSlug()`.
 *   2. `UPDATE billing_line_items SET short_slug = $cand WHERE id = $lineItemId
 *      AND short_slug IS NULL RETURNING short_slug`.
 *      • Winner of the slot race → returns the new slug.
 *   3. On 23505 (cross-row UNIQUE violation): re-generate and retry, up to
 *      MAX_MINT_ATTEMPTS. Throws PAYMENT_INVALID_CONFIG if exhausted.
 *   4. On zero rows + no error: the row already had a non-NULL short_slug,
 *      meaning another concurrent /pdf caller minted into the SAME row
 *      first. Re-SELECT the row's short_slug and return THAT value, NOT the
 *      local candidate (the local candidate never landed). If the re-SELECT
 *      somehow shows short_slug = NULL, throw PAYMENT_INVALID_CONFIG
 *      defensively — the UPDATE-NULL guard should guarantee someone won.
 *
 * Caller responsibility: must only call this when the row's short_slug is
 * known to be NULL. The /pdf route's existing SELECT already exposes
 * short_slug; if non-NULL, skip this helper entirely (see AC4 of #223).
 */
export async function mintUniqueShortSlug(
  supabase: SupabaseClient,
  lineItemId: string,
): Promise<string> {
  for (let attempt = 0; attempt < MAX_MINT_ATTEMPTS; attempt++) {
    const candidate = generateShortSlug();

    const { data: updated, error: updateErr } = await supabase
      .from("billing_line_items")
      .update({ short_slug: candidate })
      .eq("id", lineItemId)
      .is("short_slug", null)
      .select("id, short_slug");

    if (updateErr) {
      if (updateErr.code === PG_UNIQUE_VIOLATION) {
        // Cross-row collision on the partial UNIQUE index — a DIFFERENT
        // line item already owns this candidate slug. Re-generate + retry.
        continue;
      }
      throw new PaymentError(
        `Failed to mint short slug: ${updateErr.message}`,
        "PAYMENT_INVALID_CONFIG",
        500,
        updateErr,
      );
    }

    if (updated && updated.length > 0) {
      // Slot-race winner. The candidate landed on the row.
      return candidate;
    }

    // Zero rows + no error → another caller minted into the same row first.
    // Re-SELECT the row's value (NOT the local candidate, which never landed).
    const { data: row, error: selectErr } = await supabase
      .from("billing_line_items")
      .select("short_slug")
      .eq("id", lineItemId)
      .maybeSingle<{ short_slug: string | null }>();
    if (selectErr) {
      throw new PaymentError(
        `Failed to re-read short slug after concurrent mint: ${selectErr.message}`,
        "PAYMENT_INVALID_CONFIG",
        500,
        selectErr,
      );
    }
    if (!row || !row.short_slug) {
      // Should not happen — the UPDATE-NULL guard guarantees someone won and
      // persisted before we get here. Defensive: surface as invalid_config
      // rather than NPE.
      throw new PaymentError(
        "Concurrent short-slug mint race resolved to no persisted slug.",
        "PAYMENT_INVALID_CONFIG",
        500,
      );
    }
    return row.short_slug;
  }

  throw new PaymentError(
    `Failed to mint a unique short slug after ${MAX_MINT_ATTEMPTS} attempts (cross-row collision).`,
    "PAYMENT_INVALID_CONFIG",
    500,
  );
}
