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
 *  7. else             → 'other'
 *
 * Returns lowercase device_type enum values matching the AB #50 schema.
 * Never returns legacy uppercase values (GRID, UNKNOWN, etc.).
 */

import type { DeviceType } from "@/lib/types/domain";

export function classifyDeviceType(
  factoryId: string,
  nature?: string
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

  // Rule 7: fallback
  return "other";
}
