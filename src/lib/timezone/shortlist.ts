/**
 * shortlist.ts — derive a short IANA-timezone candidate list for a microgrid
 * from its structured address columns (#357, tz-awareness anchor #353).
 *
 * Two derivation paths, in priority order:
 *
 *   1. `address_country` — curated country-name → zones map below. Primary
 *      path: MBE microgrids carry a free-text country column, and the map is
 *      keyed on normalized names (plus common aliases). Coverage is the
 *      MBE deployment footprint (East Africa) plus common operator
 *      countries; an unmapped country simply falls through to path 2 or an
 *      empty shortlist — the "Other zone…" full-list picker always exists,
 *      so the map never gates what an operator can choose.
 *
 *   2. `lng` — coarse offset heuristic: zones whose CURRENT UTC offset
 *      equals round(lng / 15) hours, capped. This is deliberately rough
 *      (political zone borders don't follow meridians — Kampala at 32.6°E
 *      is UTC+3, not the meridian's +2), which is why it is the fallback,
 *      not the primary, and why the result is a shortlist, not an answer.
 *
 * "UTC" always heads the list (it is the schema default on
 * `microgrids.timezone`, migration 00055).
 *
 * Pure module — safe on server and client. Zone names are filtered through
 * `isSupportedTimezone` so a stale map entry can never seed an invalid value.
 */

import { isSupportedTimezone } from "@/lib/validation/timezone";

// ── Country map ──────────────────────────────────────────────────────────
// Keys are normalized (lowercase, trimmed) country names as an operator
// would type them into `address_country`. Multiple zones where a country
// legitimately spans several.
const COUNTRY_ZONES: Record<string, string[]> = {
  // East Africa (deployment footprint)
  uganda: ["Africa/Kampala"],
  kenya: ["Africa/Nairobi"],
  tanzania: ["Africa/Dar_es_Salaam"],
  rwanda: ["Africa/Kigali"],
  burundi: ["Africa/Bujumbura"],
  ethiopia: ["Africa/Addis_Ababa"],
  somalia: ["Africa/Mogadishu"],
  "south sudan": ["Africa/Juba"],
  sudan: ["Africa/Khartoum"],
  "democratic republic of the congo": ["Africa/Kinshasa", "Africa/Lubumbashi"],
  "dr congo": ["Africa/Kinshasa", "Africa/Lubumbashi"],
  drc: ["Africa/Kinshasa", "Africa/Lubumbashi"],
  // Rest of Africa
  nigeria: ["Africa/Lagos"],
  ghana: ["Africa/Accra"],
  senegal: ["Africa/Dakar"],
  "ivory coast": ["Africa/Abidjan"],
  "cote d'ivoire": ["Africa/Abidjan"],
  cameroon: ["Africa/Douala"],
  zambia: ["Africa/Lusaka"],
  zimbabwe: ["Africa/Harare"],
  malawi: ["Africa/Blantyre"],
  mozambique: ["Africa/Maputo"],
  "south africa": ["Africa/Johannesburg"],
  botswana: ["Africa/Gaborone"],
  namibia: ["Africa/Windhoek"],
  egypt: ["Africa/Cairo"],
  morocco: ["Africa/Casablanca"],
  // Common operator countries
  spain: ["Europe/Madrid", "Atlantic/Canary"],
  germany: ["Europe/Berlin"],
  france: ["Europe/Paris"],
  "united kingdom": ["Europe/London"],
  uk: ["Europe/London"],
  netherlands: ["Europe/Amsterdam"],
  portugal: ["Europe/Lisbon"],
  italy: ["Europe/Rome"],
  "united states": ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
  usa: ["America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles"],
  india: ["Asia/Kolkata"],
};

// Cap for the lng-derived fallback so a popular offset (e.g. UTC+1) doesn't
// flood the Select with dozens of rows.
const LNG_FALLBACK_CAP = 10;

// ── Offset helper ────────────────────────────────────────────────────────
// Current UTC offset in minutes for a zone, via Intl (no offset tables).
// Memoized per zone; offsets can drift across DST boundaries but shortlist
// derivation only needs "now" granularity.
const offsetCache = new Map<string, number>();

function offsetMinutes(iana: string, ref: Date = new Date()): number | null {
  const cached = offsetCache.get(iana);
  if (cached !== undefined) return cached;
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: iana,
      timeZoneName: "longOffset",
    }).formatToParts(ref);
    const token = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // "GMT" (zero) or "GMT±HH:MM"
    const m = token.match(/^GMT(?:([+-])(\d{2}):(\d{2}))?$/);
    if (!m) return null;
    const minutes = m[1]
      ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]))
      : 0;
    offsetCache.set(iana, minutes);
    return minutes;
  } catch {
    return null;
  }
}

export interface ShortlistInput {
  address_country?: string | null;
  lat?: number | null;
  lng?: number | null;
}

/**
 * Shortlist of candidate IANA zones for a microgrid. Always starts with
 * "UTC"; never empty; deduped; every entry passes `isSupportedTimezone`.
 */
export function timezoneShortlist(input: ShortlistInput): string[] {
  const zones: string[] = ["UTC"];

  const country = (input.address_country ?? "").trim().toLowerCase();
  const mapped = country ? COUNTRY_ZONES[country] : undefined;

  if (mapped) {
    for (const z of mapped) {
      if (isSupportedTimezone(z) && !zones.includes(z)) zones.push(z);
    }
    return zones;
  }

  if (typeof input.lng === "number" && Number.isFinite(input.lng)) {
    const targetMinutes = Math.round(input.lng / 15) * 60;
    for (const z of Intl.supportedValuesOf("timeZone")) {
      if (zones.length >= 1 + LNG_FALLBACK_CAP) break;
      if (offsetMinutes(z) === targetMinutes && !zones.includes(z)) {
        zones.push(z);
      }
    }
  }

  return zones;
}

/**
 * Safe-default nudge predicate (#357 AC-4): when the address implies a
 * non-UTC zone while the stored timezone is still 'UTC', return the first
 * implied zone whose current offset differs from UTC — the zone the nudge
 * offers to set. Returns null when there is nothing to nudge about
 * (non-UTC already set, no address signal, or the implied zone IS at
 * UTC+0 right now, e.g. Europe/London in winter — nudging there would be
 * noise, not signal).
 */
export function impliedNonUtcZone(
  microgrid: ShortlistInput & { timezone?: string | null },
): string | null {
  if ((microgrid.timezone ?? "UTC") !== "UTC") return null;
  for (const z of timezoneShortlist(microgrid)) {
    if (z === "UTC") continue;
    const off = offsetMinutes(z);
    if (off !== null && off !== 0) return z;
  }
  return null;
}
