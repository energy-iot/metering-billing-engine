/** Config stored in meters.data_source_config for openems type */
export type OpenEmsDataSourceConfig = {
  edgeId: string; // e.g. "edge0"
  channelAddress: string; // e.g. "meter0/ActiveConsumptionEnergy"
};

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

export type MeterEnergyResult = {
  meterId: string;
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

/** Meter type classification */
export type MeterType = "GRID" | "PRODUCTION" | "CONSUMPTION" | "UNKNOWN";

/** A discovered meter from OpenEMS */
export type DiscoveredMeter = {
  componentId: string;
  alias: string;
  meterType: MeterType;
  channelAddress: string;
};

/** Discovery result per edge */
export type EdgeDiscoveryResult = {
  edgeId: string;
  online: boolean;
  meters: DiscoveredMeter[];
};
