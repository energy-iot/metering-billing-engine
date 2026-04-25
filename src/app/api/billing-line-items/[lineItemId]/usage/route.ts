import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import {
  isRunGenerationFatal,
  runGenerationFor,
} from "@/lib/billing/generate";

/**
 * PATCH /api/billing-line-items/[lineItemId]/usage (#158, rewritten in #173)
 *
 * Manual usage entry for un-metered (manual-billing) households. Today's
 * call surface is preserved exactly:
 *
 *   Body:  { usage_kwh?: number; end_kwh?: number }   (at least one)
 *   200:   { lineItem: <updated row> }
 *   400:   invalid body / negative / non-numeric / underflow
 *   403:   caller cannot access microgrid
 *   404:   line item not found / RLS-hidden
 *   409:   device_linked  (line_item.device_id != NULL OR household has a
 *                          primary_consumption_meter link)
 *   409:   period_closed  (per Out-of-Scope: closed-period regenerate ships
 *                          via POST /generate, not this inline-edit path)
 *
 * Internal change: the route delegates to `runGenerationFor` with
 * `householdIds: [<resolved>]` + `manualReadings: [<resolved>]` so that
 * the line-item write goes through `fn_record_line_item_with_audit`. This
 * gives us:
 *   - One audit log entry per manual cell edit (event_type =
 *     line_item_regenerated, with previous_total_amount + new_total_amount).
 *   - UPSERT-preserve semantics for payment fields (matches the bulk path).
 *
 * Behavioral asymmetry preserved (Out of Scope): closed-period regenerate
 * ships only via POST /generate. This inline cell-edit path continues to
 * reject closed periods with 409 period_closed.
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

  // Explicit auth gate (BC1 AC6) — anonymous calls return 401 instead of
  // a confusing 404 / 500-on-RLS.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", reason: "unauthorized" },
      { status: 401 }
    );
  }

  // 1. Resolve line item → period → microgrid.
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
      {
        error: `Failed to look up line item: ${scopeErr.message}`,
        reason: "unknown_error",
      },
      { status: 500 }
    );
  }
  if (!scopedRaw) {
    return NextResponse.json(
      { error: "Line item not found.", reason: "not_found" },
      { status: 404 }
    );
  }

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
      {
        error: "You do not have permission to update this line item.",
        reason: "forbidden",
      },
      { status: 403 }
    );
  }

  // 3. Closed-period reject preserved (Out of Scope contract).
  if (period.status === "closed") {
    return NextResponse.json(
      { error: "Cannot edit a closed period", reason: "period_closed" },
      { status: 409 }
    );
  }

  // 4. Reject metered rows. Both signals must be checked: the line item's
  //    own device_id AND the household's current primary_consumption_meter
  //    link (a household may have a meter but the line item was inserted
  //    pre-link).
  if (scoped.device_id !== null) {
    return NextResponse.json(
      {
        error: "Use Refresh Readings for metered households",
        reason: "device_linked",
      },
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
      {
        error: `Failed to verify household meter link: ${linkErr.message}`,
        reason: "unknown_error",
      },
      { status: 500 }
    );
  }
  if (meterLink) {
    return NextResponse.json(
      {
        error: "Use Refresh Readings for metered households",
        reason: "device_linked",
      },
      { status: 409 }
    );
  }

  // 5. Resolve start/end/usage. Same matrix as before:
  //   - both provided → use both verbatim (server-derives usage if it
  //     differs from end - start; the BC1 generate engine always derives,
  //     so we standardize to end_kwh authoritative when both provided)
  //   - only end_kwh   → derive usage_kwh = end_kwh - start_kwh
  //   - only usage_kwh → end_kwh = start_kwh + usage_kwh (so generate
  //     engine sees a consistent {start, end, usage} triple)
  const startKwh = scoped.start_kwh ?? 0;
  let nextEnd: number;

  if (parsed.usage_kwh !== undefined && parsed.end_kwh !== undefined) {
    // Both provided — prefer end_kwh as authoritative input. The generate
    // engine will derive usage_kwh = end_kwh - start_kwh.
    nextEnd = parsed.end_kwh;
  } else if (parsed.end_kwh !== undefined) {
    nextEnd = parsed.end_kwh;
    if (parsed.end_kwh - startKwh < 0) {
      return NextResponse.json(
        {
          error: "end_kwh must be greater than or equal to start_kwh",
          reason: "invalid_body",
        },
        { status: 400 }
      );
    }
  } else {
    // usage_kwh only — derive end_kwh = start_kwh + usage_kwh.
    nextEnd = startKwh + (parsed.usage_kwh as number);
  }

  // 6. Delegate to runGenerationFor (mode='write') with this household.
  const out = await runGenerationFor({
    supabase,
    periodId: period.id,
    householdIds: [scoped.household_id],
    manualReadings: [
      {
        householdId: scoped.household_id,
        startKwh,
        endKwh: nextEnd,
      },
    ],
    mode: "write",
    actorUserId: user.id,
  });

  if (isRunGenerationFatal(out)) {
    // Pass-through fatal status (e.g. 400 missing rate schedule).
    const reason =
      out.status === 400
        ? "missing_rate_schedule"
        : out.status === 404
          ? "not_found"
          : "unknown_error";
    return NextResponse.json(
      {
        error: out.body.error,
        reason,
        ...(out.body.code ? { code: out.body.code } : {}),
      },
      { status: out.status }
    );
  }

  // Locate the per-household result for our line item.
  const result = out.results.find((r) => r.householdId === scoped.household_id);
  if (!result) {
    return NextResponse.json(
      {
        error: "Failed to update line item: no result returned.",
        reason: "unknown_error",
      },
      { status: 500 }
    );
  }
  if (result.kind === "error") {
    // Preserve the historical 400 invalid_body shape for invalid_manual_reading.
    if (result.code === "invalid_manual_reading") {
      return NextResponse.json(
        { error: result.error, reason: "invalid_body" },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: result.error, reason: "unknown_error" },
      { status: 500 }
    );
  }
  if (result.kind === "preview") {
    // Should never happen — we requested write mode.
    return NextResponse.json(
      { error: "Internal error: preview returned in write mode.", reason: "unknown_error" },
      { status: 500 }
    );
  }

  return NextResponse.json({ lineItem: result.lineItem }, { status: 200 });
}
