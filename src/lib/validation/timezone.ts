/**
 * timezone.ts — IANA timezone validation (#357, tz-awareness anchor #353).
 *
 * Server-side check that a string is a real IANA zone id. Rejects the
 * ticket's canonical garbage — "Kampala" (city, not a zone), "" (empty),
 * "UTC+3" (offset, not a zone) — and everything else that would poison the
 * billing-period stamp trigger (migration 00055).
 *
 * Why Intl-resolution rather than bare `Intl.supportedValuesOf('timeZone')`
 * membership: that list carries only ONE canonical id per zone, and WHICH
 * one depends on the runtime's ICU/CLDR data (observed locally: the list
 * has 'Asia/Calcutta' but not 'Asia/Kolkata' — the modern primary id). A
 * browser offering the modern id to a server with older CLDR would be
 * rejected on membership despite being a perfectly valid zone. Instead:
 *
 *   1. `"UTC"` is accepted literally (schema default; not in the list).
 *   2. The id must contain "/" — this rejects offset shapes ("UTC+3",
 *      "+03:00") and bare abbreviations ("EST") that Intl would happily
 *      resolve but that lose DST identity (the whole point of storing an
 *      IANA id). Every geographic IANA id is Area/Location.
 *   3. `Intl.DateTimeFormat` must construct without throwing (RangeError
 *      on unknown ids like "Mars/OlympusMons").
 *
 * `canonicalTimezone` additionally returns the runtime's canonical form
 * (case-folded, alias-resolved) — the write paths store THAT, so the
 * database never accumulates casing/alias variants of the same zone.
 */

/**
 * Resolve an input to this runtime's canonical IANA id, or null when the
 * input is not a valid geographic IANA zone (or literal "UTC").
 */
export function canonicalTimezone(input: string): string | null {
  if (!input) return null;
  if (input === "UTC") return "UTC";
  if (!input.includes("/")) return null;
  try {
    return new Intl.DateTimeFormat("en", { timeZone: input }).resolvedOptions()
      .timeZone;
  } catch {
    // RangeError: unknown time zone.
    return null;
  }
}

/** True iff `tz` is the literal "UTC" or a resolvable IANA zone id. */
export function isSupportedTimezone(tz: string): boolean {
  return canonicalTimezone(tz) !== null;
}

/**
 * Validates an IANA timezone string. Returns an error message if invalid,
 * or null if valid. Mirrors `validateCurrency`'s contract (string | null).
 */
export function validateTimezone(input: string): string | null {
  if (!input) return "Timezone is required.";
  if (!isSupportedTimezone(input)) {
    return `Invalid timezone: '${input}'. Expected an IANA zone id like 'Africa/Kampala'.`;
  }
  return null;
}
