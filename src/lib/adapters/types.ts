/**
 * Generic device data adapter interface.
 * OpenEMS is adapter #1. Future adapters (CSV, Modbus, etc.) implement this same interface.
 *
 * Post-#101: the `edge_data_source` enum was dropped and OpenEMS became the only
 * supported backend type. `openems_backend_url` moved from `edges` to `microgrids`
 * as part of the per-microgrid backend config, so DeviceConfig no longer carries
 * per-device URL state — the client is constructed from a microgrid-level config.
 */

export interface DeviceReading {
  deviceId: string;
  usageKwh: number | null; // null = no data available
  startDate: string;
  endDate: string;
}

export interface DeviceConfig {
  id: string; // Supabase device UUID
  edgeOpenemsId: string; // openems_edge_id column on the parent edge
  componentId: string; // openems_component_id column on the device
}

export interface DeviceDataAdapter {
  /**
   * `timezone` is a plain IANA zone name (e.g. "Africa/Kampala") — a string,
   * not an adapter-specific type, so the contract stays backend-agnostic.
   * The adapter resolves `startDate`/`endDate` (YYYY-MM-DD) to local-day
   * boundaries in that zone; MBE never does offset math itself (#355).
   *
   * Callers in billing pass the billing period's *stamped* timezone
   * (`billing_periods.timezone`), never the microgrid's current value — the
   * stamp is written once at period INSERT and regeneration must reproduce
   * the identical window (#354/#355). If that stamping rule changes, revisit.
   */
  getReadings(
    devices: DeviceConfig[],
    startDate: string,
    endDate: string,
    timezone: string
  ): Promise<DeviceReading[]>;
  getStatus?(
    edgeIds: string[]
  ): Promise<Record<string, { online: boolean }>>;
}
