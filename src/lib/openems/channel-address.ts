/**
 * channelAddressFor — maps a classified DeviceType to its OpenEMS billing channel.
 *
 * Returns null for device types that do not have a single well-defined
 * consumption-energy channel (battery, inverter, grid_meter, pv_meter, other).
 * Callers must handle null explicitly — do not fall back to ActiveConsumptionEnergy.
 *
 * Dispatch is on the *classified* DeviceType (from classifyDeviceType), not on
 * the raw OpenEMS nature string.
 */

import type { DeviceType } from "@/lib/types/domain";

export function channelAddressFor(
  componentId: string,
  deviceType: DeviceType
): string | null {
  switch (deviceType) {
    case "consumption_meter":
    case "ev_charger":
      // EVCS inherits ElectricityMeter shape in OpenEMS — same channel applies.
      return `${componentId}/ActiveConsumptionEnergy`;

    case "grid_meter":
      // Grid meters expose signed ActiveEnergy or separate
      // ActiveProductionEnergy / ActiveConsumptionEnergy pairs.
      // No single scalar is correct for household billing; deferred.
      return null;

    case "pv_meter":
      // Bi-directional semantics; not billed as household consumption.
      return null;

    case "battery":
      // ESS exposes ActiveChargeEnergy / ActiveDischargeEnergy / Soc —
      // not single-valued for billing.
      return null;

    case "inverter":
      // Inverters are monitored via an upstream ProductionMeter,
      // not billed directly.
      return null;

    case "other":
      console.warn(
        `channelAddressFor: unmapped deviceType "${deviceType}" for component "${componentId}"`
      );
      return null;

    default: {
      // Exhaustiveness guard — if DeviceType gains a new variant, TypeScript
      // will error here (unreachable assignment).
      const _exhaustive: never = deviceType;
      void _exhaustive;
      console.warn(
        `channelAddressFor: unknown deviceType "${deviceType}" for component "${componentId}"`
      );
      return null;
    }
  }
}
