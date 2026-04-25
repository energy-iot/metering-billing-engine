import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { calculateTieredCost } from "@/lib/billing/calculations";
import type { TierConfig } from "@/lib/types/domain";

/**
 * PATCH /api/billing-line-items/[lineItemId]/usage
 *
 * Manual usage entry for un-metered (manual-billing) households. Added in
 * #158 alongside the no-meter household-creation path. The route is the
 * single write surface for the BillingTable's inline-edit cells (END kWh,
 * USAGE kWh) on rows where `device_id IS NULL`.
 *
 * Body:
 *   { usage_kwh?: number; end_kwh?: number }
 *   At least one of the two must be present (else 400).
 *
 * Server-side semantics:
 *   - When both `usage_kwh` and `end_kwh` are provided, prefer the explicit
 *     values (no derivation override).
 *   - When only `end_kwh` is provided, derive `usage_kwh = end_kwh -
 *     start_kwh` (where start_kwh is read from the row).
 *   - When only `usage_kwh` is provided, leave `end_kwh` untouched.
 *
 * Recomputes `tier_breakdown` and `total_amount` via `calculateTieredCost`
 * using the microgrid's most recent rate_schedule (mirrors the Refresh
 * Readings code path in src/app/api/billing/generate/route.ts).
 *
 * Authorization:
 *   - currentUserCanAccessMicrogrid via the line-item → period → microgrid
 *     chain (mirrors households/[id]/route.ts pattern).
 *
 * Rejects:
 *   - 400 invalid JSON / missing both keys / negative or non-numeric values
 *   - 403 caller cannot access this microgrid
 *   - 404 line item not found / RLS-hidden
 *   - 409 device_linked — household has a primary_consumption_meter
 *     (Refresh Readings is the only valid update path for metered rows)
 *   - 409 period_closed — billing period status is 'closed'
 *
 * Response:
 *   200 { lineItem: <updated row> }
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ParsedBody = {
  usage_kwh: number | undefined;
  end_kwh: number | undefined;
};

function parseBody(raw: unknown): ParsedBody | { error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Request body must be an object" };
  }
  const rec = raw as Record<string, unknown>;

  let usage_kwh: number | undefined;
  let end_kwh: number | undefined;

  if ("usage_kwh" in rec && rec.usage_kwh !== undefined) {
    if (typeof rec.usage_kwh !== "number" || !Number.isFinite(rec.usage_kwh)) {
      return { error: "usage_kwh must be a finite number" };
    }
    if (rec.usage_kwh < 0) {
      return { error: "usage_kwh must be a non-negative number" };
    }
    usage_kwh = rec.usage_kwh;
  }

  if ("end_kwh" in rec && rec.end_kwh !== undefined) {
    if (typeof rec.end_kwh !== "number" || !Number.isFinite(rec.end_kwh)) {
      return { error: "end_kwh must be a finite number" };
    }
    if (rec.end_kwh < 0) {
      return { error: "end_kwh must be a non-negative number" };
    }
    end_kwh = rec.end_kwh;
  }

  if (usage_kwh === undefined && end_kwh === undefined) {
    return { error: "At least one of usage_kwh or end_kwh is required" };
  }

  return { usage_kwh, end_kwh };
}

type LineItemScope = {
  id: string;
  device_id: string | null;
  start_kwh: number | null;
  end_kwh: number | null;
  usage_kwh: number | null;
  household_id: string;
  billing_period_id: string;
  billing_periods: {
    id: string;
    microgrid_id: string;
    status: string;
  } | null;
};

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> }
): Promise<NextResponse> {
  const { lineItemId } = await params;

  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json(
      { error: "Invalid line item id — expected UUID.", reason: "bad_request" },
      { status: 400 }
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body", reason: "bad_request" },
      { status: 400 }
    );
  }

  const parsed = parseBody(raw);
  if ("error" in parsed) {
    return NextResponse.json(
      { error: parsed.error, reason: "invalid_body" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // 1. Resolve line item → period → microgrid in one shot. RLS-hidden rows
  //    surface as null → 404.
  const { data: scopedRaw, error: scopeErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
      device_id,
      start_kwh,
      end_kwh,
      usage_kwh,
      household_id,
      billing_period_id,
      billing_periods!inner (
        id,
        microgrid_id,
        status
      )
    `
    )
    .eq("id", lineItemId)
    .maybeSingle();

  if (scopeErr) {
    return NextResponse.json(
      { error: `Failed to look up line item: ${scopeErr.message}`, reason: "unknown_error" },
      { status: 500 }
    );
  }
  if (!scopedRaw) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 }
    );
  }

  // PostgREST sometimes returns single relations as single-element arrays;
  // normalize that just like the payment-status route does.
  const scoped = scopedRaw as unknown as LineItemScope;
  const period = Array.isArray(scoped.billing_periods)
    ? scoped.billing_periods[0]
    : scoped.billing_periods;
  if (!period) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 }
    );
  }

  // 2. Permission gate.
  if (!(await currentUserCanAccessMicrogrid(supabase, period.microgrid_id))) {
    return NextResponse.json(
      { error: "You do not have permission to update this line item.", reason: "forbidden" },
      { status: 403 }
    );
  }

  // 3. Reject manual-edit on closed periods.
  if (period.status === "closed") {
    return NextResponse.json(
      { error: "Cannot edit a closed period", reason: "period_closed" },
      { status: 409 }
    );
  }

  // 4. Reject manual-edit on rows whose household has a primary_consumption_meter
  //    link. The presence of a non-null device_id on the line item is a
  //    fast first signal, but a household may have a meter linked WITHOUT
  //    the line item having captured a device_id yet (e.g. between create
  //    and first Refresh). The authoritative check is on household_devices.
  if (scoped.device_id !== null) {
    return NextResponse.json(
      { error: "Use Refresh Readings for metered households", reason: "device_linked" },
      { status: 409 }
    );
  }

  const { data: meterLink, error: linkErr } = await supabase
    .from("household_devices")
    .select("device_id")
    .eq("household_id", scoped.household_id)
    .eq("role", "primary_consumption_meter")
    .maybeSingle();

  if (linkErr) {
    return NextResponse.json(
      { error: `Failed to verify household meter link: ${linkErr.message}`, reason: "unknown_error" },
      { status: 500 }
    );
  }
  if (meterLink) {
    return NextResponse.json(
      { error: "Use Refresh Readings for metered households", reason: "device_linked" },
      { status: 409 }
    );
  }

  // 5. Resolve final usage/end values.
  //    - both provided → use both verbatim
  //    - only end_kwh   → derive usage_kwh = end_kwh - start_kwh
  //    - only usage_kwh → leave end_kwh as-is on the row
  const startKwh = scoped.start_kwh ?? 0;
  let nextUsage: number;
  let nextEnd: number | null;

  if (parsed.usage_kwh !== undefined && parsed.end_kwh !== undefined) {
    nextUsage = parsed.usage_kwh;
    nextEnd = parsed.end_kwh;
  } else if (parsed.end_kwh !== undefined) {
    nextEnd = parsed.end_kwh;
    const derived = parsed.end_kwh - startKwh;
    if (derived < 0) {
      return NextResponse.json(
        { error: "end_kwh must be greater than or equal to start_kwh", reason: "invalid_body" },
        { status: 400 }
      );
    }
    nextUsage = derived;
  } else {
    nextUsage = parsed.usage_kwh as number;
    nextEnd = scoped.end_kwh;
  }

  // 6. Re-fetch the microgrid's latest rate_schedule + recompute the bill.
  const { data: schedule, error: scheduleError } = await supabase
    .from("rate_schedules")
    .select("*")
    .eq("microgrid_id", period.microgrid_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (scheduleError || !schedule) {
    return NextResponse.json(
      { error: "No rate schedule found for this microgrid", reason: "missing_rate_schedule" },
      { status: 400 }
    );
  }

  const calc = calculateTieredCost(
    nextUsage,
    schedule.tiers as TierConfig[],
    schedule.service_charge,
    schedule.tax_rate
  );

  // 7. Update the row + return the fresh payload.
  const updatePayload = {
    usage_kwh: nextUsage,
    end_kwh: nextEnd,
    tier_breakdown: calc.tierBreakdown,
    total_amount: calc.totalAmount,
  };

  const { data: updated, error: updateError } = await supabase
    .from("billing_line_items")
    .update(updatePayload)
    .eq("id", lineItemId)
    .select()
    .single();

  if (updateError) {
    if (updateError.code === "42501" || updateError.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this line item.", reason: "rls_denied" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update line item: ${updateError.message}`, reason: "unknown_error" },
      { status: 500 }
    );
  }

  return NextResponse.json({ lineItem: updated }, { status: 200 });
}
