/**
 * Pesapal order-id construction.
 *
 * ID layout: `INV-{26}-{13}` = 44 chars
 *   - `INV-`            (4 chars)  fixed prefix
 *   - 26 base32 chars   (26 chars) crockford-base32 of the 16-byte UUID
 *   - `-`               (1 char)
 *   - `Date.now()`      (13 chars) millisecond timestamp; Pesapal rejects
 *                                  duplicate ids, so re-clicks on the same
 *                                  line item must produce a fresh suffix
 *
 * Pesapal caps `id` at 50 chars (see
 * https://developer.pesapal.com/how-to-integrate/e-commerce/api-30-json/submitorderrequest).
 * The previous `INV-{uuid}-{ms}` format was 54 chars and would have failed
 * Pesapal-side validation; this encoding leaves a 6-char safety margin.
 *
 * Why crockford-base32: alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ` omits
 * `I`, `L`, `O`, `U` so the id remains unambiguous if it is ever read aloud
 * or transcribed by hand. The encoding is bijective on the 128-bit UUID
 * input, so collisions on the base32 piece occur iff the source UUIDs
 * collide (i.e. it inherits v4-UUID's 122 bits of entropy).
 */

const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * Encode a UUID string (with or without dashes) as 26 chars of
 * crockford-base32. The 128-bit input → 26 × 5-bit chars (the final char
 * carries 3 valid bits + 2 zero pad bits — no `=` padding emitted).
 */
export function uuidToCrockfordBase32(uuid: string): string {
  const hex = uuid.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error(`Invalid UUID: ${uuid}`);
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  let bits = 0;
  let value = 0;
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD_ALPHABET[(value >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += CROCKFORD_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/**
 * Build a Pesapal-safe order id from a `billing_line_items.id` UUID.
 * Returns `INV-{26 base32 chars}-{ms}` (44 chars total, ≤50 char limit).
 */
export function buildOrderId(lineItemId: string): string {
  return `INV-${uuidToCrockfordBase32(lineItemId)}-${Date.now()}`;
}
