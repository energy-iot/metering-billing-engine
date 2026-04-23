import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";
import type { DeviceEnergyResult } from "@/lib/openems/types";
import type { DeviceConfig } from "@/lib/adapters/types";

type EnergyRequestBody = {
  deviceIds: string[];
  fromDate: string;
  toDate: string;
};

type DeviceError = {
  deviceId: string;
  error: string;
};

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

  // Look up devices with their parent edges from Supabase (respects RLS via server client)
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
        data_source_type,
        openems_edge_id,
        openems_backend_url
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

  // Filter for openems-type devices and collect errors for unsupported ones
  const openEmsDeviceConfigs: DeviceConfig[] = [];
  const errors: DeviceError[] = [];

  for (const row of devicesWithEdges) {
    const edge = (row as unknown as { edges: { data_source_type: string; openems_edge_id: string | null; openems_backend_url: string | null } }).edges;

    if (edge.data_source_type !== "openems") {
      errors.push({
        deviceId: row.id,
        error: `Device has unsupported data source type: ${edge.data_source_type}`,
      });
      continue;
    }

    if (!edge.openems_edge_id || !row.openems_component_id || !edge.openems_backend_url) {
      errors.push({
        deviceId: row.id,
        error: "Device is missing openems_component_id or parent edge is missing openems_edge_id / openems_backend_url",
      });
      continue;
    }

    openEmsDeviceConfigs.push({
      id: row.id,
      dataSourceType: "openems",
      edgeOpenemsId: edge.openems_edge_id,
      componentId: row.openems_component_id,
      openems_backend_url: edge.openems_backend_url,
    });
  }

  if (openEmsDeviceConfigs.length === 0) {
    return NextResponse.json({ results: [], errors });
  }

  try {
    const client = getOpenEmsClient();
    const results: DeviceEnergyResult[] = await client.getDeviceEnergy(
      openEmsDeviceConfigs,
      body.fromDate,
      body.toDate
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
