import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { TierConfig } from "@/lib/types/domain";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/rate-schedules
 *
 * Creates a new rate schedule for a microgrid.
 *
 * Request body:
 * {
 *   microgrid_id: string;    // UUID
 *   tiers: TierConfig[];     // at least one tier
 *   service_charge: number;  // >= 0
 *   tax_rate: number;        // [0, 1]
 * }
 *
 * RLS: rate_schedules FOR ALL policy (00002_rls.sql:161) enforces microgrid access
 * via user_can_access_microgrid(). No additional handler-side check needed.
 *
 * Returns the inserted RateSchedule row on success (200).
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }

  const {
    microgrid_id,
    tiers,
    service_charge,
    tax_rate,
  } = body as Record<string, unknown>;

  // Validate microgrid_id
  if (typeof microgrid_id !== "string" || !UUID_RE.test(microgrid_id)) {
    return NextResponse.json(
      { error: "microgrid_id must be a valid UUID" },
      { status: 400 }
    );
  }

  const validationError = validatePayload(tiers, service_charge, tax_rate);
  if (validationError) {
    return NextResponse.json({ error: validationError }, { status: 400 });
  }

  const supabase = await createClient();

  const { data, error } = await supabase
    .from("rate_schedules")
    .insert({
      microgrid_id,
      tiers: tiers as TierConfig[],
      service_charge: service_charge as number,
      tax_rate: tax_rate as number,
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to create a rate schedule for this microgrid" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to create rate schedule: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json(data, { status: 200 });
}

/**
 * Validates tiers, service_charge, and tax_rate.
 * Returns an error string on failure, or null on success.
 */
export function validatePayload(
  tiers: unknown,
  service_charge: unknown,
  tax_rate: unknown
): string | null {
  // tiers must be an array with at least one entry
  if (!Array.isArray(tiers) || tiers.length === 0) {
    return "tiers must be a non-empty array (at least 1 tier required)";
  }

  for (let i = 0; i < tiers.length; i++) {
    const tier = tiers[i] as Partial<TierConfig>;
    const isLast = i === tiers.length - 1;

    if (typeof tier.min_kwh !== "number" || tier.min_kwh <= 0) {
      return `Tier ${i + 1}: min_kwh must be greater than 0`;
    }

    if (typeof tier.rate_per_kwh !== "number" || tier.rate_per_kwh <= 0) {
      return `Tier ${i + 1}: rate_per_kwh must be greater than 0`;
    }

    if (!isLast) {
      // Non-last tiers must have a finite max_kwh
      if (tier.max_kwh === null || tier.max_kwh === undefined || typeof tier.max_kwh !== "number") {
        return `Tier ${i + 1}: only the last tier may have max_kwh null`;
      }
      // Contiguity check: this tier's min_kwh must equal previous tier's max_kwh + 1
      if (i > 0) {
        const prev = tiers[i - 1] as Partial<TierConfig>;
        if (typeof prev.max_kwh === "number" && tier.min_kwh !== prev.max_kwh + 1) {
          return `Tier ${i + 1}: min_kwh must be ${prev.max_kwh + 1} (contiguous with tier ${i})`;
        }
      }
    } else {
      // Last tier contiguity check (max_kwh may be null)
      if (i > 0) {
        const prev = tiers[i - 1] as Partial<TierConfig>;
        if (typeof prev.max_kwh === "number" && tier.min_kwh !== prev.max_kwh + 1) {
          return `Tier ${i + 1}: min_kwh must be ${prev.max_kwh + 1} (contiguous with tier ${i})`;
        }
      }
    }
  }

  // service_charge >= 0
  if (typeof service_charge !== "number" || service_charge < 0) {
    return "service_charge must be a number >= 0";
  }

  // tax_rate ∈ [0, 1]
  if (typeof tax_rate !== "number" || tax_rate < 0 || tax_rate > 1) {
    return "tax_rate must be a number between 0 and 1 (inclusive)";
  }

  return null;
}
