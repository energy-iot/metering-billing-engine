import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * POST /api/households/with-meter
 *
 * Creates a household AND links its primary_consumption_meter in one atomic
 * RPC (`fn_create_household_with_meter`). Used by the Add-Household wizard
 * (UX2 / #74). The RPC is SECURITY INVOKER — RLS on households and
 * household_devices decides whether the caller may write.
 *
 * Authorization:
 *   - RLS via user_can_access_microgrid(microgrid_id) on households INSERT
 *   - The RPC's own safety guards reject cross-microgrid device_ids and
 *     non-consumption-meter device types BEFORE any write happens.
 *
 * Request body:
 * {
 *   microgrid_id:         string;
 *   display_name:         string;
 *   device_id:            string;
 *   primary_phone?:       string | null;
 *   primary_email?:       string | null;
 *   address_line1?:       string | null;
 *   address_line2?:       string | null;
 *   unit_label?:          string | null;
 *   address_city?:        string | null;
 *   address_region?:      string | null;
 *   address_country?:     string | null;
 *   address_postal_code?: string | null;
 *   geography_notes?:     string | null;
 * }
 *
 * Response:
 *   201 { household_id: string }
 *   400 invalid JSON
 *   403 RLS denial (42501) or "device does not belong" / "not a consumption_meter"
 *   409 partial unique index collision (meter already assigned)
 *   422 missing required field
 *   500 unexpected
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const microgrid_id =
    typeof body.microgrid_id === "string" ? body.microgrid_id.trim() : "";
  if (!microgrid_id) {
    return NextResponse.json(
      { error: "microgrid_id is required.", field: "microgrid_id" },
      { status: 422 }
    );
  }

  const display_name =
    typeof body.display_name === "string" ? body.display_name.trim() : "";
  if (!display_name) {
    return NextResponse.json(
      { error: "display_name is required.", field: "display_name" },
      { status: 422 }
    );
  }

  const device_id =
    typeof body.device_id === "string" ? body.device_id.trim() : "";
  if (!device_id) {
    return NextResponse.json(
      { error: "device_id is required.", field: "device_id" },
      { status: 422 }
    );
  }

  const optional = (v: unknown): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t ? t : null;
  };

  const supabase = await createClient();

  const { data, error } = await supabase.rpc("fn_create_household_with_meter", {
    p_microgrid_id: microgrid_id,
    p_display_name: display_name,
    p_device_id: device_id,
    p_primary_phone: optional(body.primary_phone) ?? undefined,
    p_primary_email: optional(body.primary_email) ?? undefined,
    p_address_line1: optional(body.address_line1) ?? undefined,
    p_address_line2: optional(body.address_line2) ?? undefined,
    p_unit_label: optional(body.unit_label) ?? undefined,
    p_address_city: optional(body.address_city) ?? undefined,
    p_address_region: optional(body.address_region) ?? undefined,
    p_address_country: optional(body.address_country) ?? undefined,
    p_address_postal_code: optional(body.address_postal_code) ?? undefined,
    p_geography_notes: optional(body.geography_notes) ?? undefined,
  });

  if (error) {
    // Row-level security denial → 403.
    if (
      error.code === "42501" ||
      error.message.includes("row-level security")
    ) {
      return NextResponse.json(
        { error: "Not authorized to create a household on this microgrid." },
        { status: 403 }
      );
    }

    // RPC safety guards raise generic EXCEPTION (no SQLSTATE) → map known
    // substrings to 403. These are client-side failures, not server errors.
    const msg = error.message || "";
    if (msg.includes("does not belong to microgrid")) {
      return NextResponse.json(
        {
          error:
            "Selected meter does not belong to this microgrid. Pick another meter.",
        },
        { status: 403 }
      );
    }
    if (msg.includes("is not a consumption_meter")) {
      return NextResponse.json(
        { error: "Selected device is not a consumption meter." },
        { status: 422 }
      );
    }

    // Unique-constraint violation — the partial unique index prevents a
    // second primary_consumption_meter on the same household. In this
    // endpoint the only way we'd see 23505 is a race where the chosen
    // meter was just assigned to another household.
    if (error.code === "23505") {
      return NextResponse.json(
        {
          error:
            "This meter was just assigned to another household. Pick another meter.",
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: `Could not create household: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ household_id: data as string }, { status: 201 });
}
