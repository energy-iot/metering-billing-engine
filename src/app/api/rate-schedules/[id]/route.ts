import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { TierConfig } from "@/lib/types/domain";
import { validatePayload } from "../route";

/**
 * PUT /api/rate-schedules/[id]
 *
 * Updates an existing rate schedule by ID.
 *
 * Request body:
 * {
 *   tiers: TierConfig[];     // at least one tier, contiguous
 *   service_charge: number;  // >= 0
 *   tax_rate: number;        // [0, 1]
 * }
 *
 * RLS: rate_schedules FOR ALL policy (00002_rls.sql:161) enforces microgrid access
 * via user_can_access_microgrid(). No additional handler-side check needed.
 *
 * Returns the updated RateSchedule row on success (200).
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }

  const { tiers, service_charge, tax_rate } = body as Record<string, unknown>;

  const validationError = validatePayload(tiers, service_charge, tax_rate);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("rate_schedules")
    .update({
      tiers: tiers as TierConfig[],
      service_charge: service_charge as number,
      tax_rate: tax_rate as number,
    })
    .eq("id", id)
    .select("*")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this rate schedule" },
        { status: 403 }
      );
    }
    if (error.code === "PGRST116") {
      // PostgREST: no rows returned by .single()
      return NextResponse.json(
        { error: "Rate schedule not found" },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update rate schedule: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json(data, { status: 200 });
}
