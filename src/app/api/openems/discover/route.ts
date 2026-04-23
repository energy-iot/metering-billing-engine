import { NextRequest, NextResponse } from "next/server";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { createClient } from "@/lib/supabase/server";
import { classifyDeviceType } from "@/lib/openems/classify";
import type { DiscoveredDevice, EdgeDiscoveryResponse } from "@/lib/openems/types";

/**
 * Nature IDs for device types supported by Discover.
 * Expanded from ElectricityMeter-only to include Ess, Evcs, Inverter
 * so battery / EV charger / inverter device types are discoverable.
 */
const SUPPORTED_NATURE_IDS = [
  "io.openems.edge.meter.api.ElectricityMeter",
  "io.openems.edge.ess.api.Ess",
  "io.openems.edge.evcs.api.Evcs",
  "io.openems.edge.inverter.api.Inverter",
];

/**
 * Derive a channel address from a component ID and its primary nature.
 * Consumption / grid / PV meters use ActiveConsumptionEnergy; others fall back
 * to the same convention until richer channel mapping is needed.
 */
function channelAddressFor(componentId: string): string {
  return `${componentId}/ActiveConsumptionEnergy`;
}

/**
 * GET /api/openems/discover?edgeId=<id>
 *
 * Single-edge discovery (F #57). Accepts exactly one `edgeId` param.
 * Response: { edgeId, online, devices: DiscoveredDevice[] }
 *
 * Each device includes:
 *   componentId, factoryId, alias, nature, openemsChannelAddress,
 *   suggestedDeviceType, alreadyAdded
 *
 * alreadyAdded is true when a devices row already exists for
 * (edge_id, openems_channel_address) — prevents duplicate saves.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const edgeId = request.nextUrl.searchParams.get("edgeId");

  if (!edgeId || !edgeId.trim()) {
    return NextResponse.json(
      { error: "Missing required query parameter: edgeId" },
      { status: 400 }
    );
  }

  // Reject multi-value usage (e.g. ?edgeId=a&edgeId=b).
  const allEdgeIds = request.nextUrl.searchParams.getAll("edgeId");
  if (allEdgeIds.length > 1) {
    return NextResponse.json(
      { error: "Only a single edgeId is accepted. Multi-edge discovery is not supported." },
      { status: 400 }
    );
  }

  try {
    const openems = getOpenEmsClient();
    const supabase = await createClient();

    // Fetch edge status and config in parallel.
    const [statuses, config] = await Promise.all([
      openems.getEdgesStatus([edgeId]),
      openems.getEdgeConfig(edgeId).catch(() => null),
    ]);

    const online = statuses.find((s) => s.edgeId === edgeId)?.online ?? false;

    if (!config) {
      const response: EdgeDiscoveryResponse = { edgeId, online: false, devices: [] };
      return NextResponse.json(response);
    }

    // Collect components whose factory exposes a supported nature.
    const discovered: DiscoveredDevice[] = [];

    for (const [componentId, component] of Object.entries(config.components)) {
      const factory = config.factories[component.factoryId];
      if (!factory) continue;

      // Find the first matching nature for classification.
      const matchedNature = factory.natureIds.find((n) =>
        SUPPORTED_NATURE_IDS.includes(n)
      );
      if (!matchedNature) continue;

      const openemsChannelAddress = channelAddressFor(componentId);

      discovered.push({
        componentId,
        factoryId: component.factoryId,
        alias: component.alias,
        nature: matchedNature,
        openemsChannelAddress,
        suggestedDeviceType: classifyDeviceType(component.factoryId, matchedNature),
        alreadyAdded: false, // filled in below after dedup check
      });
    }

    // Dedup check: look up existing devices rows for this edge by channel address.
    // We resolve the DB edge row via the edge's openems_edge_id.
    if (discovered.length > 0) {
      const channelAddresses = discovered.map((d) => d.openemsChannelAddress);

      // Find the edge row in DB (the API receives the OpenEMS edge ID string,
      // but the DB edge PK is a UUID; join via openems_edge_id).
      const { data: edgeRows } = await supabase
        .from("edges")
        .select("id")
        .eq("openems_edge_id", edgeId)
        .limit(1);

      const dbEdgeId = edgeRows?.[0]?.id ?? null;

      if (dbEdgeId) {
        const { data: existingDevices } = await supabase
          .from("devices")
          .select("openems_component_id")
          .eq("edge_id", dbEdgeId)
          .in("openems_component_id", discovered.map((d) => d.componentId));

        const existingComponentIds = new Set(
          (existingDevices ?? []).map((d) => d.openems_component_id ?? "")
        );

        // Mark already-added entries. We key on componentId (= openems_component_id)
        // because the existing schema uses UNIQUE (edge_id, openems_component_id).
        // The ticket specifies (edge_id, openems_channel_address) as the dedup key;
        // channel address is derived deterministically from componentId, so they are
        // equivalent for this edge.
        for (const device of discovered) {
          device.alreadyAdded = existingComponentIds.has(device.componentId);
        }

        // Suppress unused variable warning for channelAddresses
        void channelAddresses;
      }
    }

    const response: EdgeDiscoveryResponse = { edgeId, online, devices: discovered };
    return NextResponse.json(response);
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
