import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/devices
 *
 * Transactional upsert of discovered devices (F #57).
 * Browser NEVER writes `devices` directly — this route is the only write path.
 *
 * Request body:
 * {
 *   edgeId: string;          // DB UUID of the edge (NOT the OpenEMS edge ID string)
 *   devices: Array<{
 *     componentId: string;   // OpenEMS component ID (e.g. "meter0")
 *     factoryId: string;     // OpenEMS factory ID
 *     openemsChannelAddress: string;
 *     deviceType: string;    // device_type enum value
 *     name: string;          // operator-supplied display name
 *   }>
 * }
 *
 * Upsert key: (edge_id, openems_component_id)
 * On conflict: updates device_type and name (idempotent re-discovery).
 *
 * RLS: Supabase Row Level Security on the `devices` table enforces that only
 * users with user_can_access_microgrid() for the edge's microgrid can insert.
 * The server client uses the caller's auth session (cookies) so RLS applies.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("edgeId" in body) ||
    !("devices" in body)
  ) {
    return NextResponse.json(
      { error: "Request body must include edgeId and devices" },
      { status: 400 }
    );
  }

  const { edgeId, devices } = body as {
    edgeId: unknown;
    devices: unknown;
  };

  if (typeof edgeId !== "string" || !edgeId.trim()) {
    return NextResponse.json(
      { error: "edgeId must be a non-empty string" },
      { status: 400 }
    );
  }

  if (!Array.isArray(devices) || devices.length === 0) {
    return NextResponse.json(
      { error: "devices must be a non-empty array" },
      { status: 400 }
    );
  }

  // Validate each device entry
  for (const device of devices) {
    if (
      typeof device !== "object" ||
      device === null ||
      typeof device.componentId !== "string" ||
      typeof device.deviceType !== "string" ||
      typeof device.name !== "string"
    ) {
      return NextResponse.json(
        {
          error:
            "Each device must have componentId (string), deviceType (string), and name (string)",
        },
        { status: 400 }
      );
    }
  }

  const supabase = await createClient();

  // Build upsert rows. openems_component_id is required for OpenEMS-sourced edges.
  const rows = (
    devices as Array<{
      componentId: string;
      factoryId?: string;
      openemsChannelAddress?: string;
      deviceType: string;
      name: string;
    }>
  ).map((d) => ({
    edge_id: edgeId,
    name: d.name.trim() || d.componentId,
    device_type: d.deviceType as
      | "consumption_meter"
      | "grid_meter"
      | "pv_meter"
      | "battery"
      | "inverter"
      | "ev_charger"
      | "other",
    openems_component_id: d.componentId,
    config: {} as Record<string, never>,
  }));

  // Upsert: INSERT ... ON CONFLICT (edge_id, openems_component_id) DO UPDATE
  // The UNIQUE constraint on devices(edge_id, openems_component_id) was added in
  // 00001_schema.sql (AB #50). This upsert is atomic per Postgres transaction semantics.
  const { data, error } = await supabase
    .from("devices")
    .upsert(rows, {
      onConflict: "edge_id,openems_component_id",
      ignoreDuplicates: false, // update device_type + name on conflict
    })
    .select("id, name, device_type, openems_component_id");

  if (error) {
    // RLS violation surfaces as a PostgREST 403 / error code.
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to add devices to this edge" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to save devices: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ saved: data ?? [] }, { status: 200 });
}
