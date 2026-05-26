import { NextRequest, NextResponse } from "next/server";
import { checkInternalApiKey } from "@/lib/internal-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { runGenerationFor, isRunGenerationFatal } from "@/lib/billing/generate";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest) {
  if (!checkInternalApiKey(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
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
  // PLACEHOLDER: actor_ref will become the per-org token name when #255
  // lands (Wave B). Until then, we stamp `'pre-token-system'` so audit
  // rows are still traceable to "this came from the customerapp internal
  // route, before token-based auth was wired in".
  const out = await runGenerationFor({
    supabase,
    periodId: rec.billingPeriodId,
    manualReadings,
    mode: "write",
    actorUserId: null,
    actorKind: "customerapp",
    actorRef: "pre-token-system",
  });

  if (isRunGenerationFatal(out)) {
    return NextResponse.json(out.body, { status: out.status });
  }

  const lineItems = out.results.filter((r) => r.kind === "written").length;
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
