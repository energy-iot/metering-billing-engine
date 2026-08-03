import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import {
  isRunGenerationFatal,
  runGenerationFor,
  type ManualReadingInput,
  type SeedReadingInput,
} from "@/lib/billing/generate";

/**
 * POST /api/billing/generate (#173, BC1)
 *
 * Body:
 *   billingPeriodId: string                                — required
 *   householdIds?: string[]                                — optional
 *     - undefined → process every household on the period's microgrid
 *       (legacy bulk Refresh-Readings behavior)
 *     - []        → explicit no-op (writes nothing, returns empty arrays)
 *     - [uuid…]   → only those households are processed
 *   manualReadings?: Array<{
 *     householdId: string;
 *     startKwh: number;
 *     endKwh: number;
 *     reason?: string;
 *   }>
 *     - implicitly adds each household to the processed set
 *     - skips the OpenEMS call for that household; uses startKwh/endKwh
 *       as provided; usage_kwh is server-derived (endKwh - startKwh)
 *
 * AC3 changes from the legacy route:
 *   - Closed periods are NOT rejected (Q4=B logs `period_was_closed: true`).
 *   - The bulk legacy delete-then-insert is REPLACED with UPSERT-preserve
 *     via fn_record_line_item_with_audit (preserves payment_status, paid_at,
 *     paid_by_user_id, payment_notes, pesapal_order_id, payment_failed_at,
 *     payment_refunded_at — and the payment_events history that would
 *     otherwise CASCADE away).
 *   - A bulk-regenerate target with reading_source='manual' currently AND no
 *     manualReadings entry → skipped + surfaced in errors[] with
 *     code='currently_manual'. Q5 enforcement.
 *   - manualReadings for a household NOT in the period's microgrid → skipped
 *     + surfaced in errors[] with code='unknown_household'. Cross-microgrid
 *     attack defense.
 *
 * Auth (NEW): explicit getUser() gate before any business logic — today's
 * route relies entirely on RLS. Returning 401 explicitly gives BC2/BC3 a
 * predictable upstream signal.
 *
 * Response:
 *   { lineItems: number; errors: Array<...> }
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RawManualReading = {
  householdId: unknown;
  startKwh: unknown;
  endKwh: unknown;
  reason?: unknown;
};

type ParseError = { error: string; details?: unknown };

type ParsedBody = {
  billingPeriodId: string;
  householdIds?: string[];
  manualReadings?: ManualReadingInput[];
  seedReadings?: SeedReadingInput[];
};

/**
 * Manual validation mirroring the Zod schema spec'd in #173 AC3 (Zod is not
 * a project dependency yet — same behavior, hand-rolled). Returns either
 * `{ parsed }` or `{ error, details }` — the route surfaces the error tree
 * verbatim as `{ error: 'invalid_body', details }`.
 */
function parseBody(raw: unknown): { parsed: ParsedBody } | ParseError {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "Body must be an object" };
  }
  const rec = raw as Record<string, unknown>;

  // billingPeriodId — required UUID.
  if (typeof rec.billingPeriodId !== "string" || !UUID_RE.test(rec.billingPeriodId)) {
    return { error: "billingPeriodId must be a UUID string" };
  }
  const billingPeriodId = rec.billingPeriodId;

  // householdIds — optional UUID array (empty array allowed).
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

  // manualReadings — optional array of { householdId, startKwh, endKwh, reason? }.
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
        return {
          error: `manualReadings[${i}].endKwh must be >= startKwh`,
        };
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

  // seedReadings — optional array of { deviceId, dialReadingKwh, readAt, startKwh } (#339).
  //
  // All four are required together. `startKwh` is derived by the client as
  // `dialReadingKwh − usage(period start → readAt)`.
  //
  // WHAT THIS VALIDATES, precisely: shape, and the ordering invariant
  // `startKwh <= dialReadingKwh` — you cannot have consumed a negative amount
  // since the period began. It does NOT re-derive the subtraction: OpenEMS is
  // not consulted here, so a wrong `startKwh` that still sits below the dial
  // reading is accepted.
  //
  // That is a real gap and it is stated rather than papered over. Re-deriving
  // server-side is buildable — `POST /api/openems/energy` already answers
  // usage over an arbitrary window — and is tracked separately rather than
  // claimed here. An earlier version of this comment asserted the
  // recomputation; the comment was wrong, not the code, and a comment
  // promising a stronger guarantee than the code delivers is the exact defect
  // this repo has spent three days removing from migrations.
  //
  // The inputs travel with the derived value regardless, so a wrong seed stays
  // diagnosable a year later instead of anonymous.
  let seedReadings: SeedReadingInput[] | undefined;
  if (rec.seedReadings !== undefined) {
    if (!Array.isArray(rec.seedReadings)) {
      return { error: "seedReadings must be an array" };
    }
    const out: SeedReadingInput[] = [];
    const seenDevices = new Set<string>();
    for (let i = 0; i < rec.seedReadings.length; i++) {
      const r = rec.seedReadings[i] as Record<string, unknown>;
      if (!r || typeof r !== "object") {
        return { error: `seedReadings[${i}] must be an object` };
      }
      if (typeof r.deviceId !== "string" || !UUID_RE.test(r.deviceId)) {
        return { error: `seedReadings[${i}].deviceId must be a UUID` };
      }
      // One seed per device. Two entries for the same meter is a client bug,
      // and silently taking the last one would make which reading was used
      // depend on array order.
      if (seenDevices.has(r.deviceId)) {
        return { error: `seedReadings has more than one entry for device ${r.deviceId}` };
      }
      seenDevices.add(r.deviceId);
      for (const f of ["dialReadingKwh", "startKwh"] as const) {
        const v = r[f];
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
          return {
            error: `seedReadings[${i}].${f} must be a non-negative finite number`,
          };
        }
      }
      if (typeof r.readAt !== "string" || Number.isNaN(Date.parse(r.readAt))) {
        return { error: `seedReadings[${i}].readAt must be an ISO timestamp` };
      }
      // The dial cannot read less than the period's own usage implies.
      if ((r.startKwh as number) > (r.dialReadingKwh as number)) {
        return {
          error: `seedReadings[${i}].startKwh cannot exceed dialReadingKwh`,
        };
      }
      out.push({
        deviceId: r.deviceId,
        dialReadingKwh: r.dialReadingKwh as number,
        readAt: r.readAt,
        startKwh: r.startKwh as number,
      });
    }
    seedReadings = out;
  }

  return { parsed: { billingPeriodId, householdIds, manualReadings, seedReadings } };
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

  // Explicit auth gate (AC6). The legacy route relied on RLS only; this is
  // belt-and-suspenders so anonymous calls return 401, not 500-on-RLS.
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
    seedReadings: parsed.seedReadings,
    mode: "write",
    actorUserId: user.id,
  });

  if (isRunGenerationFatal(out)) {
    return NextResponse.json(out.body, { status: out.status });
  }

  // Shape the response: split written + errors.
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
