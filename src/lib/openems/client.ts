import type { MeterConfig, MeterDataAdapter, MeterReading } from "@/lib/adapters/types";
import { OpenEmsError } from "./errors";
import type { OpenEmsAuth } from "./auth";
import type {
  ChannelValue,
  EdgeConfig,
  EdgeStatus,
  JsonRpcResponse,
  MeterEnergyResult,
  OpenEmsDataSourceConfig,
} from "./types";

export class OpenEmsClient implements MeterDataAdapter {
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
   * Implement MeterDataAdapter.getStatus.
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
   * Implement MeterDataAdapter.getReadings.
   * Groups meters by edgeId, batches channel queries per edge,
   * and converts Wh to kWh.
   */
  async getReadings(
    meters: MeterConfig[],
    startDate: string,
    endDate: string
  ): Promise<MeterReading[]> {
    // Validate and group meters by edgeId
    const edgeGroups = new Map<
      string,
      { meterId: string; channelAddress: string }[]
    >();

    for (const meter of meters) {
      const config = meter.dataSourceConfig as OpenEmsDataSourceConfig;
      if (!config.edgeId || !config.channelAddress) {
        throw new OpenEmsError(
          `Meter ${meter.id} has invalid data_source_config: missing edgeId or channelAddress`,
          "METER_INVALID_DATA_SOURCE",
          400,
          { meterId: meter.id, config }
        );
      }

      const group = edgeGroups.get(config.edgeId) ?? [];
      group.push({ meterId: meter.id, channelAddress: config.channelAddress });
      edgeGroups.set(config.edgeId, group);
    }

    // Query each edge in parallel
    const results: MeterReading[] = [];
    const edgeQueries = Array.from(edgeGroups.entries()).map(
      async ([edgeId, meterInfos]) => {
        const channels = meterInfos.map((m) => m.channelAddress);
        const data = await this.queryHistoricEnergy(
          edgeId,
          channels,
          startDate,
          endDate
        );

        for (const meterInfo of meterInfos) {
          const whValue = data[meterInfo.channelAddress] ?? null;
          results.push({
            meterId: meterInfo.meterId,
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
   */
  async getMeterEnergy(
    meters: MeterConfig[],
    startDate: string,
    endDate: string
  ): Promise<MeterEnergyResult[]> {
    const edgeGroups = new Map<
      string,
      { meterId: string; channelAddress: string }[]
    >();

    for (const meter of meters) {
      const config = meter.dataSourceConfig as OpenEmsDataSourceConfig;
      if (!config.edgeId || !config.channelAddress) {
        throw new OpenEmsError(
          `Meter ${meter.id} has invalid data_source_config`,
          "METER_INVALID_DATA_SOURCE",
          400
        );
      }

      const group = edgeGroups.get(config.edgeId) ?? [];
      group.push({ meterId: meter.id, channelAddress: config.channelAddress });
      edgeGroups.set(config.edgeId, group);
    }

    const results: MeterEnergyResult[] = [];
    const edgeQueries = Array.from(edgeGroups.entries()).map(
      async ([edgeId, meterInfos]) => {
        const channels = meterInfos.map((m) => m.channelAddress);
        const data = await this.queryHistoricEnergy(
          edgeId,
          channels,
          startDate,
          endDate
        );

        for (const meterInfo of meterInfos) {
          const whValue = data[meterInfo.channelAddress] ?? null;
          results.push({
            meterId: meterInfo.meterId,
            edgeId,
            channelAddress: meterInfo.channelAddress,
            energyWh: whValue,
            energyKwh: whValue !== null ? whValue / 1000 : null,
          });
        }
      }
    );

    await Promise.all(edgeQueries);
    return results;
  }
}
