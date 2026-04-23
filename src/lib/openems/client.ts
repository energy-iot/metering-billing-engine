import type { DeviceConfig, DeviceDataAdapter, DeviceReading } from "@/lib/adapters/types";
import { OpenEmsError } from "./errors";
import type { OpenEmsAuth } from "./auth";
import type {
  ChannelValue,
  DeviceEnergyResult,
  EdgeConfig,
  EdgeStatus,
  JsonRpcResponse,
} from "./types";

/**
 * Channel address convention for OpenEMS consumption meters:
 *   `${componentId}/ActiveConsumptionEnergy`
 * This suffix is OpenEMS-specific. Non-consumption channels (battery SoC, PV
 * production) would resolve their channel name from device_type in the adapter.
 */
function consumptionChannelAddress(componentId: string): string {
  return `${componentId}/ActiveConsumptionEnergy`;
}

export class OpenEmsClient implements DeviceDataAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: OpenEmsAuth
  ) {}

  /**
   * Send a JSON-RPC request to the OpenEMS B2B REST endpoint.
   */
  private async rpc<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>
  ): Promise<T> {
    // INVARIANT: the same `body` string MUST be passed to both `auth.apply`
    // (which hashes it for the SigV4 signature) AND `fetch` (which transmits it).
    // Any byte-level divergence breaks the signature and returns 403.
    const body = JSON.stringify({
      jsonrpc: "2.0" as const,
      id: crypto.randomUUID(),
      method,
      params,
    });

    const url = this.auth.resolveUrl(this.baseUrl);
    const headers = await this.auth.apply({ url, method: "POST", body });

    let response: Response;
    try {
      response = await fetch(url, { method: "POST", headers, body });
    } catch (err) {
      throw new OpenEmsError(
        `Failed to reach OpenEMS at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        "OPENEMS_UNREACHABLE",
        503,
        err
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new OpenEmsError(
        "OpenEMS B2B authentication failed",
        "OPENEMS_AUTH_FAILED",
        response.status
      );
    }

    const json = await response.json();

    if ("error" in json) {
      throw new OpenEmsError(
        `OpenEMS RPC error: ${json.error.message}`,
        "OPENEMS_RPC_ERROR",
        502,
        json.error
      );
    }

    return (json as JsonRpcResponse<T>).result;
  }

  /**
   * Get online/offline status for a list of edges.
   */
  async getEdgesStatus(edgeIds: string[]): Promise<EdgeStatus[]> {
    const result = await this.rpc<Record<string, { online: boolean }>>(
      "getEdgesStatus",
      { edgeIds }
    );

    return Object.entries(result).map(([edgeId, status]) => ({
      edgeId,
      online: status.online,
    }));
  }

  /**
   * Get the full configuration of an edge (components + factories).
   */
  async getEdgeConfig(edgeId: string): Promise<EdgeConfig> {
    const result = await this.rpc<{
      payload: JsonRpcResponse<EdgeConfig>;
    }>("edgeRpc", {
      edgeId,
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "getEdgeConfig",
        params: {},
      },
    });

    return result.payload.result;
  }

  /**
   * Query historic energy data for a single edge.
   * Returns cumulative energy values per channel in Wh.
   */
  async queryHistoricEnergy(
    edgeId: string,
    channels: string[],
    fromDate: string,
    toDate: string,
    timezone: string = "UTC"
  ): Promise<Record<string, number | null>> {
    const result = await this.rpc<{
      payload: JsonRpcResponse<{ data: Record<string, number | null> }>;
    }>("edgeRpc", {
      edgeId,
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "queryHistoricTimeseriesEnergy",
        params: {
          fromDate,
          toDate,
          channels,
          timezone,
        },
      },
    });

    return result.payload.result.data;
  }

  /**
   * Get current channel values across multiple edges.
   */
  async getEdgesChannelsValues(
    edgeIds: string[],
    channels: string[]
  ): Promise<ChannelValue[]> {
    const result = await this.rpc<
      Record<string, Record<string, number | null>>
    >("getEdgesChannelsValues", {
      ids: edgeIds,
      channels,
    });

    const values: ChannelValue[] = [];
    for (const [edgeId, channelData] of Object.entries(result)) {
      for (const [channelAddress, value] of Object.entries(channelData)) {
        values.push({ edgeId, channelAddress, value });
      }
    }
    return values;
  }

  /**
   * Implement DeviceDataAdapter.getStatus.
   */
  async getStatus(
    edgeIds: string[]
  ): Promise<Record<string, { online: boolean }>> {
    const statuses = await this.getEdgesStatus(edgeIds);
    const result: Record<string, { online: boolean }> = {};
    for (const s of statuses) {
      result[s.edgeId] = { online: s.online };
    }
    return result;
  }

  /**
   * Implement DeviceDataAdapter.getReadings.
   * Groups devices by edgeOpenemsId, batches channel queries per edge,
   * and converts Wh to kWh.
   *
   * Channel address: `${componentId}/ActiveConsumptionEnergy` (OpenEMS convention).
   */
  async getReadings(
    devices: DeviceConfig[],
    startDate: string,
    endDate: string
  ): Promise<DeviceReading[]> {
    // Validate and group devices by OpenEMS edge ID
    const edgeGroups = new Map<
      string,
      { deviceId: string; channelAddress: string }[]
    >();

    for (const device of devices) {
      if (!device.edgeOpenemsId || !device.componentId) {
        throw new OpenEmsError(
          `Device ${device.id} has invalid config: missing edgeOpenemsId or componentId`,
          "DEVICE_INVALID_DATA_SOURCE",
          400,
          { deviceId: device.id }
        );
      }

      const channelAddress = consumptionChannelAddress(device.componentId);
      const group = edgeGroups.get(device.edgeOpenemsId) ?? [];
      group.push({ deviceId: device.id, channelAddress });
      edgeGroups.set(device.edgeOpenemsId, group);
    }

    // Query each edge in parallel.
    // (Each DeviceConfig doesn't carry a URL anymore — the client was
    // constructed with a microgrid-scoped URL, applied to every edge
    // under that microgrid.)
    const results: DeviceReading[] = [];
    const edgeQueries = Array.from(edgeGroups.entries()).map(
      async ([edgeId, deviceInfos]) => {
        const channels = deviceInfos.map((d) => d.channelAddress);
        const data = await this.queryHistoricEnergy(
          edgeId,
          channels,
          startDate,
          endDate
        );

        for (const deviceInfo of deviceInfos) {
          const whValue = data[deviceInfo.channelAddress] ?? null;
          results.push({
            deviceId: deviceInfo.deviceId,
            usageKwh: whValue !== null ? whValue / 1000 : null,
            startDate,
            endDate,
          });
        }
      }
    );

    await Promise.all(edgeQueries);
    return results;
  }

  /**
   * Query historic energy and return detailed results with both Wh and kWh.
   * (Formerly getMeterEnergy — renamed to getDeviceEnergy.)
   *
   * Channel address: `${componentId}/ActiveConsumptionEnergy` (OpenEMS convention).
   */
  async getDeviceEnergy(
    devices: DeviceConfig[],
    startDate: string,
    endDate: string
  ): Promise<DeviceEnergyResult[]> {
    const edgeGroups = new Map<
      string,
      { deviceId: string; channelAddress: string }[]
    >();

    for (const device of devices) {
      if (!device.edgeOpenemsId || !device.componentId) {
        throw new OpenEmsError(
          `Device ${device.id} has invalid config: missing edgeOpenemsId or componentId`,
          "DEVICE_INVALID_DATA_SOURCE",
          400
        );
      }

      const channelAddress = consumptionChannelAddress(device.componentId);
      const group = edgeGroups.get(device.edgeOpenemsId) ?? [];
      group.push({ deviceId: device.id, channelAddress });
      edgeGroups.set(device.edgeOpenemsId, group);
    }

    const results: DeviceEnergyResult[] = [];
    const edgeQueries = Array.from(edgeGroups.entries()).map(
      async ([edgeId, deviceInfos]) => {
        const channels = deviceInfos.map((d) => d.channelAddress);
        const data = await this.queryHistoricEnergy(
          edgeId,
          channels,
          startDate,
          endDate
        );

        for (const deviceInfo of deviceInfos) {
          const whValue = data[deviceInfo.channelAddress] ?? null;
          results.push({
            deviceId: deviceInfo.deviceId,
            edgeId,
            channelAddress: deviceInfo.channelAddress,
            energyWh: whValue,
            energyKwh: whValue !== null ? whValue / 1000 : null,
          });
        }
      }
    );

    await Promise.all(edgeQueries);
    return results;
  }

  /**
   * Query per-day energy totals for a single edge across a date range.
   *
   * Uses the OpenEMS `queryHistoricTimeseriesEnergyPerPeriod` method, which
   * returns per-day energy consumption (Wh) for each channel.
   *
   * Returns a map of { date (YYYY-MM-DD) → totalKwh } summed across all channels.
   * Days with no data for any channel are omitted from the result.
   */
  async queryDailyEnergy(
    edgeId: string,
    channels: string[],
    fromDate: string,
    toDate: string,
    timezone: string = "UTC"
  ): Promise<Record<string, number>> {
    const result = await this.rpc<{
      payload: JsonRpcResponse<{
        timestamps: number[];
        data: Record<string, (number | null)[]>;
      }>;
    }>("edgeRpc", {
      edgeId,
      payload: {
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "queryHistoricTimeseriesEnergyPerPeriod",
        params: {
          fromDate,
          toDate,
          channels,
          timezone,
          resolution: { value: 1, unit: "Days" },
        },
      },
    });

    const { timestamps, data } = result.payload.result;
    const byDate: Record<string, number> = {};

    for (let i = 0; i < timestamps.length; i++) {
      const dateStr = new Date(timestamps[i]).toISOString().slice(0, 10);
      let dayTotal = 0;
      let hasData = false;
      for (const channelValues of Object.values(data)) {
        const wh = channelValues[i];
        if (wh !== null && wh !== undefined) {
          dayTotal += wh;
          hasData = true;
        }
      }
      if (hasData) {
        byDate[dateStr] = (byDate[dateStr] ?? 0) + dayTotal / 1000; // Wh → kWh
      }
    }

    return byDate;
  }
}
