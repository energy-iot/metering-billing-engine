import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromToken } from "@/lib/internal-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { runGenerationFor, isRunGenerationFatal } from "@/lib/billing/generate";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  // #255 — per-org token auth replaces the dead-code INTERNAL_API_KEY
  // model from PR #246. On failure, return the structured reason as the
  // error body.
  const auth = await resolveOrgFromToken(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rec = raw as Record<string, unknown>;

  if (typeof rec.billingPeriodId !== "string" || !UUID_RE.test(rec.billingPeriodId)) {
    return NextResponse.json({ error: "billingPeriodId must be a UUID" }, { status: 400 });
  }

  if (!Array.isArray(rec.manualReadings) || rec.manualReadings.length === 0) {
    return NextResponse.json(
      { error: "manualReadings must be a non-empty array" },
      { status: 400 }
    );
  }

  const manualReadings: Array<{
    householdId: string;
    startKwh: number;
    endKwh: number;
    reason?: string;
  }> = [];

  for (let i = 0; i < rec.manualReadings.length; i++) {
    const m = rec.manualReadings[i] as Record<string, unknown>;
    if (typeof m.householdId !== "string" || !UUID_RE.test(m.householdId)) {
      return NextResponse.json(
        { error: `manualReadings[${i}].householdId must be a UUID` },
        { status: 400 }
      );
    }
    if (typeof m.startKwh !== "number" || !Number.isFinite(m.startKwh) || m.startKwh < 0) {
      return NextResponse.json(
        { error: `manualReadings[${i}].startKwh must be a non-negative finite number` },
        { status: 400 }
      );
    }
    if (typeof m.endKwh !== "number" || !Number.isFinite(m.endKwh) || m.endKwh < m.startKwh) {
      return NextResponse.json(
        { error: `manualReadings[${i}].endKwh must be a finite number >= startKwh` },
        { status: 400 }
      );
    }
    manualReadings.push({
      householdId: m.householdId,
      startKwh: m.startKwh,
      endKwh: m.endKwh,
      ...(typeof m.reason === "string" ? { reason: m.reason } : {}),
    });
  }

  const supabase = createServiceClient();

  // SIGNATURE NOTE: `fn_record_line_item_with_audit` was widened in #250
  // (actor_kind, actor_ref) — see `src/lib/billing/generate.ts` for the
  // full rationale + PostgREST overload-resolution caveat.
  //
  // #255 — actor_ref is now the real per-org token name resolved by
  // `resolveOrgFromToken`, replacing the `'pre-token-system'` placeholder
  // from #250.
  const out = await runGenerationFor({
    supabase,
    periodId: rec.billingPeriodId,
    manualReadings,
    mode: "write",
    actorUserId: null,
    actorKind: "customerapp",
    actorRef: auth.token_name,
  });

  if (isRunGenerationFatal(out)) {
    return NextResponse.json(out.body, { status: out.status });
  }

  // #255 — response shape returns per-line-item entity IDs so the
  // customerapp can reference generated line items downstream (e.g. for
  // payment-link generation). PR #246 returned `{ lineItems: <count> }`;
  // the new shape per the AC ("POST /api/v1/billing/generate response
  // includes per-line-item IDs (full entity-IDs commitment per #249)").
  const lineItems = out.results
    .filter((r): r is Extract<typeof r, { kind: "written" }> => r.kind === "written")
    .map((r) => ({
      id: r.lineItem.id,
      householdId: r.householdId,
      householdName: r.householdName,
      totalAmount: r.lineItem.total_amount,
      usageKwh: r.lineItem.usage_kwh,
    }));

  const errors = out.results
    .filter((r) => r.kind === "error")
    .map((e) => ({
      householdId: e.householdId,
      householdName: e.householdName,
      error: e.error,
      code: e.code,
    }));

  return NextResponse.json({ lineItems, errors });
}
