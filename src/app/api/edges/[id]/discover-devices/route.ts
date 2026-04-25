import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin, currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import { classifyDeviceType } from "@/lib/openems/classify";
import { channelAddressFor } from "@/lib/openems/channel-address";
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * GET /api/edges/[id]/discover-devices
 *
 * Restored device-discovery route for the edge detail page (#114).
 * Replaces the deleted /api/openems/discover?edgeId= route (#101).
 *
 * [id] is the edge DB UUID. The route resolves openems_edge_id + microgrid_id
 * from the DB before calling the OpenEMS backend, so discovery is correctly
 * scoped to the owning microgrid's configured adapter.
 *
 * Edge lookup precedes permission check (matches delete-preview/route.ts pattern)
 * so a non-existent edge yields 404, not 403 — avoids existence leak.
 *
 * Error handling split:
 *   - getEdgesStatus: not wrapped in catch — errors surface as 503
 *   - getEdgeConfig: wrapped in .catch(() => null) — offline edge → 200 with
 *     { online: false, devices: [] }, preserving the old route's lenient behavior
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { id: edgeId } = await params;

  if (!UUID_RE.test(edgeId)) {
    return NextResponse.json(
      { error: "Invalid edge id — expected UUID." },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // Fetch the edge first so a missing edge yields 404, not 403.
  // RLS on edges filters cross-org rows; a non-existent or RLS-hidden edge
  // surfaces as null → 404, avoiding existence leaks for cross-microgrid access.
  const { data: edge, error: edgeErr } = await supabase
    .from("edges")
    .select("id, microgrid_id, openems_edge_id")
    .eq("id", edgeId)
    .maybeSingle<{ id: string; microgrid_id: string; openems_edge_id: string }>();

  if (edgeErr) {
    return NextResponse.json(
      { error: "Failed to look up edge." },
      { status: 500 }
    );
  }
  if (!edge) {
    return NextResponse.json(
      { error: "Edge not found." },
      { status: 404 }
    );
  }

  // Permission check after existence confirmed.
  // currentUserCanAccessMicrogrid returns false if the user can't access the
  // owning microgrid. Since RLS already hides cross-org edges, this primarily
  // defends against race conditions and explicit cross-microgrid requests.
  if (!(await currentUserCanAccessMicrogrid(supabase, edge.microgrid_id))) {
    return NextResponse.json(
      { error: "Edge not found." },
      { status: 404 }
    );
  }

  // Super-admin gate: getMicrogridEmsConfig throws OPENEMS_FORBIDDEN for
  // org_managers on cloud_aws (fn_get_ems_secret returns NULL). Gate here
  // explicitly so the caller gets a clean 403 rather than an opaque backend
  // config error.
  if (!(await currentUserIsSuperAdmin(supabase))) {
    return NextResponse.json(
      { error: "Only super admins can discover devices for this edge." },
      { status: 403 }
    );
  }

  // Resolve per-microgrid OpenEMS config.
  let emsConfig;
  try {
    emsConfig = await getMicrogridEmsConfig(supabase, edge.microgrid_id);
  } catch (err) {
    if (err instanceof OpenEmsError) {
      if (err.code === "OPENEMS_FORBIDDEN") {
        return NextResponse.json(
          { error: err.message, reason: "forbidden" },
          { status: 403 }
        );
      }
      return NextResponse.json(
        { error: err.message, reason: "unknown_error" },
        { status: 500 }
      );
    }
    throw err;
  }

  if (!emsConfig) {
    console.info(
      JSON.stringify({
        event: "openems.discover_devices",
        microgrid_id: edge.microgrid_id,
        edge_id: edgeId,
        openems_edge_id: edge.openems_edge_id,
        actor_user_id: null,
        online: false,
        status: "not_configured",
        device_count: 0,
        duration_ms: Date.now() - startedAt,
        at: new Date().toISOString(),
      })
    );
    return NextResponse.json(
      {
        error: "OpenEMS backend is not configured for this microgrid.",
        reason: "not_configured",
      },
      { status: 409 }
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const openems = createOpenEmsClient(emsConfig);
  const openemsEdgeId = edge.openems_edge_id;

  let statuses: Array<{ edgeId: string; online: boolean }>;

  // getEdgesStatus is NOT wrapped — auth failures and unreachable backend
  // should surface as 503 with an actionable reason.
  try {
    statuses = await openems.getEdgesStatus([openemsEdgeId]);
  } catch (err) {
    let reason: "auth_failed" | "unreachable" | "forbidden" | "unknown_error" =
      "unknown_error";
    let message = "Discover failed with an unexpected error. Check server logs.";
    let httpStatus = 503;

    if (err instanceof OpenEmsError) {
      if (err.code === "OPENEMS_AUTH_FAILED") {
        reason = "auth_failed";
        message = err.message;
      } else if (err.code === "OPENEMS_UNREACHABLE") {
        reason = "unreachable";
        message = err.message;
      } else if (err.code === "OPENEMS_FORBIDDEN") {
        reason = "forbidden";
        message = err.message;
        httpStatus = 403;
      } else {
        reason = "unknown_error";
        message = err.message;
      }
    }

    console.info(
      JSON.stringify({
        event: "openems.discover_devices",
        microgrid_id: edge.microgrid_id,
        edge_id: edgeId,
        openems_edge_id: openemsEdgeId,
        actor_user_id: user?.id ?? null,
        online: false,
        status: reason,
        device_count: 0,
        duration_ms: Date.now() - startedAt,
        at: new Date().toISOString(),
      })
    );

    return NextResponse.json({ error: message, reason }, { status: httpStatus });
  }

  const online = statuses.find((s) => s.edgeId === openemsEdgeId)?.online ?? false;

  // getEdgeConfig is lenient — an offline or misconfigured edge should not
  // crash the discover flow. When null, we return an empty device list.
  const config = await openems.getEdgeConfig(openemsEdgeId).catch(() => null);

  if (!config) {
    console.info(
      JSON.stringify({
        event: "openems.discover_devices",
        microgrid_id: edge.microgrid_id,
        edge_id: edgeId,
        openems_edge_id: openemsEdgeId,
        actor_user_id: user?.id ?? null,
        online: false,
        status: "edge_offline",
        device_count: 0,
        duration_ms: Date.now() - startedAt,
        at: new Date().toISOString(),
      })
    );
    const response: EdgeDiscoveryResponse = {
      edgeId: openemsEdgeId,
      online: false,
      devices: [],
    };
    return NextResponse.json(response);
  }

  // Classify components whose factory exposes a supported nature.
  const discovered: DiscoveredDevice[] = [];

  for (const [componentId, component] of Object.entries(config.components)) {
    const factory = config.factories[component.factoryId];
    if (!factory) continue;

    const matchedNature = factory.natureIds.find((n) =>
      SUPPORTED_NATURE_IDS.includes(n)
    );
    if (!matchedNature) continue;

    const suggestedDeviceType = classifyDeviceType(
      component.factoryId,
      matchedNature,
      component.alias
    );
    const openemsChannelAddress = channelAddressFor(componentId, suggestedDeviceType);

    discovered.push({
      componentId,
      factoryId: component.factoryId,
      alias: component.alias,
      nature: matchedNature,
      openemsChannelAddress,
      suggestedDeviceType,
      alreadyAdded: false, // filled in below after dedup check
    });
  }

  // Dedup: query devices by (edge_id DB UUID, openems_component_id).
  // Dedup key is (edge_id, openems_component_id) — UNIQUE constraint
  // in 00001_schema.sql:144. No channel-address fallback.
  if (discovered.length > 0) {
    const { data: existingDevices } = await supabase
      .from("devices")
      .select("openems_component_id")
      .eq("edge_id", edgeId)
      .in(
        "openems_component_id",
        discovered.map((d) => d.componentId)
      );

    const existingComponentIds = new Set(
      (existingDevices ?? []).map((d) => d.openems_component_id ?? "")
    );

    for (const device of discovered) {
      device.alreadyAdded = existingComponentIds.has(device.componentId);
    }
  }

  console.info(
    JSON.stringify({
      event: "openems.discover_devices",
      microgrid_id: edge.microgrid_id,
      edge_id: edgeId,
      openems_edge_id: openemsEdgeId,
      actor_user_id: user?.id ?? null,
      online,
      status: "success",
      device_count: discovered.length,
      duration_ms: Date.now() - startedAt,
      at: new Date().toISOString(),
    })
  );

  const response: EdgeDiscoveryResponse = {
    edgeId: openemsEdgeId,
    online,
    devices: discovered,
  };
  return NextResponse.json(response);
}
