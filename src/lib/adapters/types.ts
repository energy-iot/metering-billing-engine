/**
 * Generic device data adapter interface.
 * OpenEMS is adapter #1. Future adapters (CSV, Modbus, etc.) implement this same interface.
 *
 * Renamed from MeterDataAdapter → DeviceDataAdapter (PM decision #8):
 * the OpenEMS coordinates (edge ID + component ID) are now first-class fields on
 * the `edges` and `devices` tables rather than JSONB blobs, so the adapter
 * config shape reflects the entity model directly.
 */
import type { EdgeDataSource } from "@/lib/types/domain";

export interface DeviceReading {
  deviceId: string;
  usageKwh: number | null; // null = no data available
  startDate: string;
  endDate: string;
}

export interface DeviceConfig {
  id: string; // Supabase device UUID
  dataSourceType: EdgeDataSource; // e.g. "openems"
  edgeOpenemsId: string; // openems_edge_id column on the parent edge
  componentId: string; // openems_component_id column on the device
  openems_backend_url: string; // openems_backend_url column on the parent edge
}

export interface DeviceDataAdapter {
  getReadings(
    devices: DeviceConfig[],
    startDate: string,
    endDate: string
  ): Promise<DeviceReading[]>;
  getStatus?(
    edgeIds: string[]
  ): Promise<Record<string, { online: boolean }>>;
}
