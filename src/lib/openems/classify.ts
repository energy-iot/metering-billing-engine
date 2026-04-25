/**
 * classifyDeviceType — heuristic classifier for OpenEMS component factory IDs and natures.
 *
 * Rule order is LOAD-BEARING. Earlier rules win. Do not reorder.
 *
 * Priority order:
 *  1. GridMeter       → 'grid_meter'
 *  2. Pv* | Production → 'pv_meter'
 *  3. ConsumptionMeter → 'consumption_meter'
 *  4. Ess* | Battery*  → 'battery'
 *  5. Evcs*            → 'ev_charger'
 *  6. Inverter*        → 'inverter'
 *  7. alias fallback (consum* | load | household | house) → 'consumption_meter'
 *  8. else             → 'other'
 *
 * Returns lowercase device_type enum values matching the AB #50 schema.
 * Never returns legacy uppercase values (GRID, UNKNOWN, etc.).
 */

import type { DeviceType } from "@/lib/types/domain";

export function classifyDeviceType(
  factoryId: string,
  nature?: string,
  alias?: string
): DeviceType {
  const haystack = `${factoryId} ${nature ?? ""}`;

  // Rule 1: GridMeter (must come before ConsumptionMeter/ProductionMeter)
  if (/GridMeter/i.test(haystack)) return "grid_meter";

  // Rule 2: PV or Production meter
  if (/Pv|ProductionMeter|\.Production\./i.test(haystack)) return "pv_meter";

  // Rule 3: ConsumptionMeter
  if (/ConsumptionMeter/i.test(haystack)) return "consumption_meter";

  // Rule 4: ESS (Energy Storage System) or Battery
  if (/Ess|Battery/i.test(haystack)) return "battery";

  // Rule 5: EV charger
  if (/Evcs/i.test(haystack)) return "ev_charger";

  // Rule 6: Inverter
  if (/Inverter/i.test(haystack)) return "inverter";

  // Rule 7: alias fallback for generic AC meters (e.g. Meter.Socomec.AcUniversal)
  // Matches consum*, load, household, house bounded by start/end of string or any
  // non-letter character. Boundary = `[^A-Za-z]` (NOT `\W`) so `_` and `-` count
  // as boundaries — real-world component aliases include both (e.g. `main_load`,
  // `meter-consumption`). For multi-keyword aliases like `"PV + Consumption Total"`,
  // the first matching keyword wins → consumption_meter.
  // Regex: /(^|[^A-Za-z])(consum\w*|load|household|house)([^A-Za-z]|$)/i
  const trimmedAlias = alias?.trim();
  if (
    trimmedAlias &&
    /(^|[^A-Za-z])(consum\w*|load|household|house)([^A-Za-z]|$)/i.test(
      trimmedAlias
    )
  ) {
    return "consumption_meter";
  }

  // Rule 8: fallback
  return "other";
}
