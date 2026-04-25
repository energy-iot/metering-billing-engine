import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  isRunGenerationFatal,
  runGenerationFor,
  type ManualReadingInput,
} from "@/lib/billing/generate";

/**
 * POST /api/billing/regenerate-preview (#173, BC1)
 *
 * Same request body as /api/billing/generate. Pure compute path — performs
 * NO database writes. The OpenEMS read still happens (it's an HTTP call,
 * not a transaction). Returns the per-household preview that BC3's
 * compute-then-confirm dialog (Q6) renders.
 *
 * Body:
 *   { billingPeriodId: string;
 *     householdIds?: string[];
 *     manualReadings?: Array<{
 *       householdId: string;
 *       startKwh: number;
 *       endKwh: number;
 *       reason?: string;
 *     }>;
 *   }
 *
 * Response:
 *   { preview: Array<{
 *       householdId, householdName, startKwh, endKwh, usageKwh,
 *       tierBreakdown, totalAmount,
 *       previousTotalAmount, previousPaymentStatus,
 *     }>;
 *     errors: Array<{ householdId, householdName, error, code? }>;
 *   }
 *
 * `previousPaymentStatus` is the row's state BEFORE the regenerate would
 * write — preserved across the regenerate (AC3). DO NOT rename to
 * `currentPaymentStatus` — BC3 #175 already drafts `previousPaymentStatus`
 * consumption.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RawManualReading = {
  householdId: unknown;
  startKwh: unknown;
  endKwh: unknown;
  reason?: unknown;
};

type ParseError = { error: string };

type ParsedBody = {
  billingPeriodId: string;
  householdIds?: string[];
  manualReadings?: ManualReadingInput[];
};

/** Same shape as the generate route's parser — kept inline because the
 * route surface is small and the validation matrix is identical. */
function parseBody(raw: unknown): { parsed: ParsedBody } | ParseError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Body must be an object" };
  }
  const rec = raw as Record<string, unknown>;

  if (
    typeof rec.billingPeriodId !== "string" ||
    !UUID_RE.test(rec.billingPeriodId)
  ) {
    return { error: "billingPeriodId must be a UUID string" };
  }
  const billingPeriodId = rec.billingPeriodId;

  let householdIds: string[] | undefined;
  if (rec.householdIds !== undefined) {
    if (!Array.isArray(rec.householdIds)) {
      return { error: "householdIds must be an array of UUIDs" };
    }
    for (const h of rec.householdIds) {
      if (typeof h !== "string" || !UUID_RE.test(h)) {
        return { error: "householdIds entries must be UUID strings" };
      }
    }
    householdIds = rec.householdIds as string[];
  }

  let manualReadings: ManualReadingInput[] | undefined;
  if (rec.manualReadings !== undefined) {
    if (!Array.isArray(rec.manualReadings)) {
      return { error: "manualReadings must be an array" };
    }
    const out: ManualReadingInput[] = [];
    for (let i = 0; i < rec.manualReadings.length; i++) {
      const m = rec.manualReadings[i] as RawManualReading;
      if (!m || typeof m !== "object") {
        return { error: `manualReadings[${i}] must be an object` };
      }
      if (typeof m.householdId !== "string" || !UUID_RE.test(m.householdId)) {
        return { error: `manualReadings[${i}].householdId must be a UUID` };
      }
      if (
        typeof m.startKwh !== "number" ||
        !Number.isFinite(m.startKwh) ||
        m.startKwh < 0
      ) {
        return {
          error: `manualReadings[${i}].startKwh must be a non-negative finite number`,
        };
      }
      if (
        typeof m.endKwh !== "number" ||
        !Number.isFinite(m.endKwh) ||
        m.endKwh < 0
      ) {
        return {
          error: `manualReadings[${i}].endKwh must be a non-negative finite number`,
        };
      }
      if (m.endKwh < m.startKwh) {
        return { error: `manualReadings[${i}].endKwh must be >= startKwh` };
      }
      let reason: string | undefined;
      if (m.reason !== undefined) {
        if (typeof m.reason !== "string") {
          return { error: `manualReadings[${i}].reason must be a string` };
        }
        if (m.reason.length > 500) {
          return { error: `manualReadings[${i}].reason must be <= 500 chars` };
        }
        reason = m.reason;
      }
      out.push({
        householdId: m.householdId,
        startKwh: m.startKwh,
        endKwh: m.endKwh,
        reason,
      });
    }
    manualReadings = out;
  }

  return { parsed: { billingPeriodId, householdIds, manualReadings } };
}

export async function POST(request: NextRequest) {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parseResult = parseBody(raw);
  if ("error" in parseResult) {
    return NextResponse.json(
      { error: "invalid_body", details: parseResult.error },
      { status: 400 }
    );
  }
  const { parsed } = parseResult;

  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const out = await runGenerationFor({
    supabase,
    periodId: parsed.billingPeriodId,
    householdIds: parsed.householdIds,
    manualReadings: parsed.manualReadings,
    mode: "preview",
    actorUserId: user.id,
  });

  if (isRunGenerationFatal(out)) {
    return NextResponse.json(out.body, { status: out.status });
  }

  const preview = out.results
    .filter((r) => r.kind === "preview")
    .map((p) => ({
      householdId: p.householdId,
      householdName: p.householdName,
      startKwh: p.startKwh,
      endKwh: p.endKwh,
      usageKwh: p.usageKwh,
      tierBreakdown: p.tierBreakdown,
      totalAmount: p.totalAmount,
      previousTotalAmount: p.previousTotalAmount,
      previousPaymentStatus: p.previousPaymentStatus,
    }));

  const errors = out.results
    .filter((r) => r.kind === "error")
    .map((e) => ({
      householdId: e.householdId,
      householdName: e.householdName,
      error: e.error,
      code: e.code,
    }));

  return NextResponse.json({ preview, errors });
}
