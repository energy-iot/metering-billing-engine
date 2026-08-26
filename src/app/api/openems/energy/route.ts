import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import type { DeviceEnergyResult } from "@/lib/openems/types";
import type { DeviceConfig } from "@/lib/adapters/types";
import { validateTimezone } from "@/lib/validation/timezone";

type EnergyRequestBody = {
  deviceIds: string[];
  fromDate: string;
  toDate: string;
  /**
   * #359 — caller-supplied IANA zone the day-window is built in (same
   * threading as billing's `getReadings`, #355). Period-scoped callers
   * (e.g. the preflight seed derivation) pass the period's stamped
   * `billing_periods.timezone` so the queried window matches the billing
   * window; ambient callers pass the live `microgrids.timezone`.
   * Optional for backward compatibility — absent means "UTC".
   */
  timezone?: string;
};

type DeviceError = {
  deviceId: string;
  error: string;
};

/**
 * POST /api/openems/energy
 *
 * Post-#101: the OpenEMS client is no longer built from environment variables.
 * Every device belongs to a microgrid via edge; we resolve the microgrid and
 * build the client from the microgrid's saved ems_* config. This endpoint
 * requires all requested devices to share the same microgrid (otherwise we'd
 * need one client per microgrid, which is a future optimization).
 */
export async function POST(request: NextRequest) {
  let body: EnergyRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.deviceIds || !Array.isArray(body.deviceIds) || body.deviceIds.length === 0) {
    return NextResponse.json(
      { error: "deviceIds must be a non-empty array" },
      { status: 400 }
    );
  }

  if (!body.fromDate || !body.toDate) {
    return NextResponse.json(
      { error: "fromDate and toDate are required (YYYY-MM-DD format)" },
      { status: 400 }
    );
  }

  // #359 — validate the caller-supplied zone (no numeric-offset math; the
  // IANA name is passed through and OpenEMS/ICU resolve the offset).
  const timezone = body.timezone ?? "UTC";
  if (body.timezone !== undefined) {
    const tzError = validateTimezone(body.timezone);
    if (tzError) {
      return NextResponse.json({ error: tzError }, { status: 400 });
    }
  }

  // Look up devices with parent edge + microgrid (RLS-enforced).
  const supabase = await createClient();
  const { data: devicesWithEdges, error: dbError } = await supabase
    .from("devices")
    .select(`
      id,
      name,
      device_type,
      openems_component_id,
      config,
      created_at,
      edge_id,
      edges!inner(
        id,
        openems_edge_id,
        microgrid_id
      )
    `)
    .in("id", body.deviceIds);

  if (dbError) {
    return NextResponse.json(
      { error: `Database error: ${dbError.message}` },
      { status: 500 }
    );
  }

  if (!devicesWithEdges || devicesWithEdges.length === 0) {
    return NextResponse.json(
      { error: "No devices found for the provided IDs" },
      { status: 404 }
    );
  }

  // Collect the distinct microgrid_ids; bail if >1 (single-microgrid query only).
  const microgridIds = new Set<string>();
  const openEmsDeviceConfigs: DeviceConfig[] = [];
  const errors: DeviceError[] = [];

  for (const row of devicesWithEdges) {
    const edge = (row as unknown as {
      edges: {
        openems_edge_id: string | null;
        microgrid_id: string;
      };
    }).edges;

    if (!edge.openems_edge_id || !row.openems_component_id) {
      errors.push({
        deviceId: row.id,
        error: "Device or parent edge is missing required OpenEMS config fields",
      });
      continue;
    }

    microgridIds.add(edge.microgrid_id);

    openEmsDeviceConfigs.push({
      id: row.id,
      edgeOpenemsId: edge.openems_edge_id,
      componentId: row.openems_component_id,
    });
  }

  if (microgridIds.size > 1) {
    return NextResponse.json(
      {
        error:
          "All deviceIds must belong to the same microgrid. Cross-microgrid energy queries are not supported.",
      },
      { status: 400 }
    );
  }

  if (openEmsDeviceConfigs.length === 0) {
    return NextResponse.json({ results: [], errors });
  }

  const [microgridId] = microgridIds;

  let emsConfig;
  try {
    emsConfig = await getMicrogridEmsConfig(supabase, microgridId);
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code, results: [], errors },
        { status: err.statusCode }
      );
    }
    throw err;
  }

  if (!emsConfig) {
    return NextResponse.json(
      {
        error:
          "OpenEMS Backend not configured. Configure it first on the OpenEMS Backend tab.",
        results: [],
        errors,
      },
      { status: 409 }
    );
  }

  try {
    const client = createOpenEmsClient(emsConfig);
    const results: DeviceEnergyResult[] = await client.getDeviceEnergy(
      openEmsDeviceConfigs,
      body.fromDate,
      body.toDate,
      timezone
    );

    return NextResponse.json({ results, errors });
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code, results: [], errors },
        { status: err.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Unexpected error querying energy data", results: [], errors },
      { status: 500 }
    );
  }
}
