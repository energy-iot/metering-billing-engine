/**
 * OpenEMS-specific types for the JSON-RPC B2B API.
 *
 * Note: OpenEmsDataSourceConfig has been removed. Device connection coordinates
 * (edge ID + component ID) are now first-class columns on the `edges` and `devices`
 * tables and flow through DeviceConfig in src/lib/adapters/types.ts.
 *
 * Channel address convention for energy reads:
 *   `${componentId}/ActiveConsumptionEnergy`
 * This suffix is OpenEMS-specific; non-consumption channels (battery SoC, PV
 * production) resolve their channel name from device_type in the adapter.
 */

/** JSON-RPC request envelope */
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
};

/** JSON-RPC success response */
export type JsonRpcResponse<T = Record<string, unknown>> = {
  jsonrpc: "2.0";
  id: string;
  result: T;
};

/** JSON-RPC error response */
export type JsonRpcErrorResponse = {
  jsonrpc: "2.0";
  id: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type EdgeStatus = {
  edgeId: string;
  online: boolean;
};

export type EnergyReading = {
  channelAddress: string;
  energyWh: number | null;
  energyKwh: number | null;
};

export type DeviceEnergyResult = {
  deviceId: string;
  edgeId: string;
  channelAddress: string;
  energyWh: number | null;
  energyKwh: number | null;
};

export type ChannelValue = {
  edgeId: string;
  channelAddress: string;
  value: number | null;
};

/** Edge configuration from getEdgeConfig */
export type EdgeConfig = {
  components: Record<string, EdgeComponent>;
  factories: Record<string, EdgeFactory>;
};

export type EdgeComponent = {
  alias: string;
  factoryId: string;
  properties: Record<string, unknown>;
};

export type EdgeFactory = {
  natureIds: string[];
};

/** A discovered device from OpenEMS (formerly DiscoveredMeter) */
export type DiscoveredDevice = {
  componentId: string;
  alias: string;
  deviceType: string; // OpenEMS factory-derived classification (GRID, PRODUCTION, CONSUMPTION, UNKNOWN)
  channelAddress: string; // e.g. "meter0/ActiveConsumptionEnergy"
};

/** Discovery result per edge */
export type EdgeDiscoveryResult = {
  edgeId: string;
  online: boolean;
  devices: DiscoveredDevice[];
};
