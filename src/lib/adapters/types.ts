/**
 * Generic meter data adapter interface.
 * OpenEMS is adapter #1. Future adapters (CSV, Modbus, etc.) implement this same interface.
 */
export interface MeterReading {
  meterId: string;
  usageKwh: number | null; // null = no data available
  startDate: string;
  endDate: string;
}

export interface MeterConfig {
  id: string; // Supabase meter UUID
  dataSourceType: string; // e.g. "openems"
  dataSourceConfig: Record<string, unknown>;
}

export interface MeterDataAdapter {
  getReadings(
    meters: MeterConfig[],
    startDate: string,
    endDate: string
  ): Promise<MeterReading[]>;
  getStatus?(
    edgeIds: string[]
  ): Promise<Record<string, { online: boolean }>>;
}
