import { NextRequest, NextResponse } from "next/server";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";
import type {
  DiscoveredDevice,
  EdgeDiscoveryResult,
} from "@/lib/openems/types";

const METER_NATURE_ID = "io.openems.edge.meter.api.ElectricityMeter";

function classifyDeviceType(factoryId: string): string {
  if (/GridMeter|\.Grid\./i.test(factoryId)) return "GRID";
  if (/ProductionMeter|\.Production\./i.test(factoryId)) return "PRODUCTION";
  if (/NRCMeter|\.Nrc\.|ConsumptionMeter/i.test(factoryId))
    return "CONSUMPTION";
  return "UNKNOWN";
}

export async function GET(request: NextRequest) {
  const edgeIdsParam = request.nextUrl.searchParams.get("edgeIds");

  if (!edgeIdsParam) {
    return NextResponse.json(
      { error: "Missing required query parameter: edgeIds" },
      { status: 400 }
    );
  }

  const edgeIds = edgeIdsParam
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  if (edgeIds.length === 0) {
    return NextResponse.json(
      { error: "edgeIds parameter must contain at least one edge ID" },
      { status: 400 }
    );
  }

  try {
    const client = getOpenEmsClient();

    // Get online/offline status for all edges
    const statuses = await client.getEdgesStatus(edgeIds);
    const statusMap = new Map(statuses.map((s) => [s.edgeId, s.online]));

    // Fetch config for each edge in parallel, handling individual failures
    const edges: EdgeDiscoveryResult[] = await Promise.all(
      edgeIds.map(async (edgeId) => {
        const online = statusMap.get(edgeId) ?? false;

        try {
          const config = await client.getEdgeConfig(edgeId);
          const devices: DiscoveredDevice[] = [];

          for (const [componentId, component] of Object.entries(
            config.components
          )) {
            const factory = config.factories[component.factoryId];
            if (!factory) continue;

            if (factory.natureIds.includes(METER_NATURE_ID)) {
              devices.push({
                componentId,
                alias: component.alias,
                deviceType: classifyDeviceType(component.factoryId),
                channelAddress: `${componentId}/ActiveConsumptionEnergy`,
              });
            }
          }

          return { edgeId, online, devices };
        } catch {
          // If edge config fails (e.g. edge is offline), return empty devices
          return { edgeId, online: false, devices: [] };
        }
      })
    );

    return NextResponse.json({ edges });
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Unexpected error discovering devices" },
      { status: 500 }
    );
  }
}
