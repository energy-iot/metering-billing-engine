import "server-only";

/**
 * generate.ts — shared billing-line-item generation engine (#173, BC1).
 *
 * This module owns the per-household compute + (optionally) write loop that
 * used to live inline in `src/app/api/billing/generate/route.ts`. After BC1
 * three callers share it:
 *
 *   1. `POST /api/billing/generate` — bulk OR selective (mode='write').
 *      `householdIds`: undefined → all metered/un-metered households on the
 *      period's microgrid; `[]` → explicit no-op; `[uuid, …]` → only those.
 *      `manualReadings`: per-household `{ startKwh, endKwh, reason? }`
 *      overrides — implicit add to the processed set; the OpenEMS call is
 *      skipped for these households.
 *
 *   2. `POST /api/billing/regenerate-preview` — same body, mode='preview'.
 *      Returns the in-memory calc + previousTotalAmount/previousPaymentStatus
 *      from the prior line item; writes nothing.
 *
 *   3. `PATCH /api/billing-line-items/[lineItemId]/usage` — single-cell manual
 *      edit. Internally resolves `householdIds: [<resolved>]` +
 *      `manualReadings: [<resolved>]` and calls with mode='write'.
 *
 * ── Write semantics (mode='write') ──────────────────────────────────────────
 *
 * Every household processed goes through `fn_record_line_item_with_audit`
 * (00029), which UPSERTs by (billing_period_id, household_id) — preserving
 * payment_status / paid_at / paid_by_user_id / pesapal_order_id / payment_*
 * columns on UPDATE, so a regenerate doesn't clobber a paid row's audit
 * fields and doesn't cascade away its payment_events history. The function
 * also writes one row to billing_audit_log per call (in the same transaction).
 *
 * The legacy bulk-only delete-then-insert path is REMOVED — this is the
 * critical AC3 change. UPSERT-preserve is the only write path.
 *
 * ── Q5 enforcement (`currently_manual` skip) ───────────────────────────────
 *
 * When a household is in `householdIds` AND has `reading_source='manual'`
 * already AND is NOT in `manualReadings`, the household is skipped and
 * surfaced in `errors` with `code: 'currently_manual'`. This protects
 * against accidental manual-row clobber via bulk regenerate. BC3's per-row
 * regenerate dialog is the only blessed path to switch a row back to edge.
 *
 * ── Cross-microgrid attack defense ─────────────────────────────────────────
 *
 * `manualReadings[].householdId` that resolves to a household NOT in the
 * period's microgrid is surfaced in `errors[]` with `code: 'unknown_household'`
 * and dropped before any RPC call. RLS would also reject the write, but
 * failing fast at the route is clearer + saves a round-trip.
 *
 * ── INVARIANT (added 2026-05 with #250) ────────────────────────────────────
 *
 * With service-role callers (via `/api/v1/*`), RLS does NOT backstop
 * the cross-microgrid check above — it is the SOLE defense against
 * cross-microgrid household submission. Do NOT delete on the assumption
 * that RLS will catch it; RLS only fires for user-bound clients. See PR
 * #246 review + #250 ticket body for the original reasoning.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { calculateTieredCost } from "@/lib/billing/calculations";
import { roundKwh, roundAmount } from "@/lib/billing/precision";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import type { DeviceConfig } from "@/lib/adapters/types";
import type {
  BillingLineItem,
  BillingPeriod,
  RateSchedule,
  ReadingSource,
  TierBreakdown,
  TierConfig,
  BillingLineItemPaymentStatus,
} from "@/lib/types/domain";
import type { LineItemRegeneratedDetails } from "@/lib/types/billing-audit";

// ── Public types ────────────────────────────────────────────────────────────

export type GenerationMode = "write" | "preview";

export type ManualReadingInput = {
  householdId: string;
  startKwh: number;
  endKwh: number;
  reason?: string;
};

/**
 * A meter reading taken by the operator, used to establish `start_kwh` for a
 * device whose billing history predates its OpenEMS connection (#339).
 *
 * Not staged in the database — supplied per-request, exactly like
 * `ManualReadingInput`. The panel that collects these holds them in component
 * state until Generate.
 *
 * `dialReadingKwh` / `readAt` are the operator's inputs and `startKwh` is
 * derived from them:
 *
 *     startKwh = dialReadingKwh − usage(period.start_date → readAt)
 *
 * All three are sent. The derived value is what generation uses; the inputs
 * are what make a wrong seed diagnosable a year later rather than anonymous,
 * and the route recomputes from them and rejects a mismatch — the client's
 * arithmetic is a display convenience, not a trusted input.
 *
 * `readAt` is NOT "now". An operator can read a dial in the morning and type
 * it that evening, and the subtraction is over the interval that actually
 * elapsed. Minutes do not matter; days do.
 */
export type SeedReadingInput = {
  deviceId: string;
  dialReadingKwh: number;
  readAt: string;
  startKwh: number;
};

export type GenerationErrorCode =
  | "currently_manual"
  | "no_meter_reading"
  | "missing_openems_config"
  | "invalid_manual_reading"
  | "unmetered_no_manual"
  | "unknown_household"
  /**
   * #339. The device has no prior MBE `end_kwh` and no seed was supplied, so
   * `start_kwh` is unknowable. Previously this fell to `?? 0`, which asserted
   * the meter read zero at period start and printed that on the invoice.
   *
   * Refusing is deliberate: "I have no record" and "the meter read zero" are
   * different claims, and only one of them is safe to print on a document a
   * customer checks against the box on their wall.
   */
  | "needs_seed_reading";

export type WrittenHouseholdResult = {
  kind: "written";
  householdId: string;
  householdName: string;
  lineItem: BillingLineItem;
  previousTotalAmount: number | null;
  previousPaymentStatus: BillingLineItemPaymentStatus | null;
  previousReadingSource: ReadingSource | null;
};

export type PreviewHouseholdResult = {
  kind: "preview";
  householdId: string;
  householdName: string;
  startKwh: number;
  endKwh: number;
  usageKwh: number;
  tierBreakdown: TierBreakdown[];
  totalAmount: number;
  previousTotalAmount: number | null;
  previousPaymentStatus: BillingLineItemPaymentStatus | null;
};

export type ErrorHouseholdResult = {
  kind: "error";
  householdId: string;
  householdName: string;
  error: string;
  code: GenerationErrorCode;
};

export type HouseholdResult =
  | WrittenHouseholdResult
  | PreviewHouseholdResult
  | ErrorHouseholdResult;

export type GenerationResult = {
  results: HouseholdResult[];
};

export type RunGenerationParams = {
  supabase: SupabaseClient;
  periodId: string;
  /** undefined = all households on the microgrid; `[]` = explicit no-op. */
  householdIds?: string[];
  /** Per-household reading overrides. Households here are implicitly added
   *  to the processed set. */
  manualReadings?: ManualReadingInput[];
  /** Operator-supplied starting readings, keyed by device (#339). */
  seedReadings?: SeedReadingInput[];
  mode: GenerationMode;
  /** Resolved `auth.uid()` from the route's session. Required when
   *  mode='write' (passed to RPC as actor + entered_by_user_id for manual).
   *
   *  For non-human callers (customerapp via `/api/v1/*`, future
   *  cron jobs, etc.) pass `null` and set `actorKind` + `actorRef`. The
   *  DB CHECK on `billing_audit_log` enforces the (kind, user_id, ref)
   *  shape (see migration 00041 / #250). */
  actorUserId: string | null;
  /** Defaults to `'human'` for backwards compatibility with all existing
   *  in-app callers (the dashboard routes). `'customerapp'` is set by
   *  `/api/v1/*` routes; `'system'` by webhook ingestors.
   *  See migration 00041 (#250). */
  actorKind?: "human" | "customerapp" | "system";
  /** Opaque caller-supplied identifier — token name for customerapp,
   *  source key (e.g. `'pesapal_ipn'`) for system. Required by DB CHECK
   *  whenever `actorKind != 'human'`. */
  actorRef?: string | null;
};

export type RunGenerationFatal =
  | { kind: "fatal"; status: number; body: { error: string; code?: string } };

export type RunGenerationOutput = GenerationResult | RunGenerationFatal;

export function isRunGenerationFatal(
  out: RunGenerationOutput
): out is RunGenerationFatal {
  return (out as RunGenerationFatal).kind === "fatal";
}

// ── Internal types (kept private) ───────────────────────────────────────────

type HouseholdRow = {
  id: string;
  display_name: string;
  household_devices: {
    role: string;
    devices: {
      id: string;
      openems_component_id: string | null;
      edges: {
        openems_edge_id: string | null;
      } | null;
    } | null;
  }[];
};

type PriorItem = {
  household_id: string;
  total_amount: number;
  payment_status: BillingLineItemPaymentStatus;
  reading_source: ReadingSource;
  end_kwh: number | null;
  device_id: string | null;
  // ── New for #218 (previous-snapshot capture) ─────────────────────────────
  // Required to build `auditDetails.previous_snapshot` for the
  // `line_item_regenerated` event. The SELECT at :362 must read these too —
  // the explicit `as unknown as PriorItem[]` cast at :366 suppresses
  // PostgREST's inferred shape, so widening this type without widening the
  // SELECT would compile but resolve `undefined` at runtime.
  start_kwh: number | null;
  usage_kwh: number | null;
  /** JSONB — shape is `TierBreakdown[]` in the live row but we keep it
   *  `unknown` here to match the audit-snapshot contract (round-trip,
   *  no validation). */
  tier_breakdown: unknown;
  entered_by_user_id: string | null;
  entered_at: string | null;
  manual_reason: string | null;
};

// ── Implementation ──────────────────────────────────────────────────────────

/**
 * Compute (and optionally persist) billing line items for a billing period.
 *
 * Returns a `RunGenerationFatal` for whole-request errors (bad period, bad
 * status, RLS-hidden, OpenEMS misconfig). Returns a `GenerationResult` whose
 * `results` array is one entry per household (kind: 'written' | 'preview' |
 * 'error').
 */
export async function runGenerationFor(
  params: RunGenerationParams
): Promise<RunGenerationOutput> {
  const { supabase, periodId, mode, actorUserId } = params;
  const actorKind = params.actorKind ?? "human";
  const actorRef = params.actorRef ?? null;
  const householdIdsParam = params.householdIds;
  const manualReadingsParam = params.manualReadings ?? [];
  // #339. Keyed by device, not household: a seed is a reading of a specific
  // physical meter, and the same household can change meters.
  const seedByDevice = new Map<string, SeedReadingInput>();
  for (const s of params.seedReadings ?? []) seedByDevice.set(s.deviceId, s);

  // ── 0. Empty-array short-circuit (AC3 explicit no-op) ─────────────────────
  // `householdIds: []` AND `manualReadings: []` is a well-defined no-op.
  if (
    householdIdsParam !== undefined &&
    householdIdsParam.length === 0 &&
    manualReadingsParam.length === 0
  ) {
    return { results: [] };
  }

  // ── 1. Fetch billing period (RLS gates access) ────────────────────────────
  const { data: periodRow, error: periodError } = await supabase
    .from("billing_periods")
    .select("*")
    .eq("id", periodId)
    .single();

  if (periodError || !periodRow) {
    return {
      kind: "fatal",
      status: 404,
      body: { error: "Billing period not found" },
    };
  }
  const billingPeriod = periodRow as BillingPeriod;

  // Q4=B: closed-period regenerate IS allowed via /api/billing/generate (the
  // legacy reject removed in this ticket). PATCH /usage retains its own
  // `period_closed` reject upstream — see the route handler.

  // ── 2. Fetch rate schedule ────────────────────────────────────────────────
  const { data: schedule, error: scheduleError } = await supabase
    .from("rate_schedules")
    .select("*")
    .eq("microgrid_id", billingPeriod.microgrid_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (scheduleError || !schedule) {
    return {
      kind: "fatal",
      status: 400,
      body: { error: "No rate schedule found for this microgrid" },
    };
  }
  const rateSchedule = schedule as RateSchedule;

  // ── 3. Fetch households on the period's microgrid (LEFT join) ─────────────
  const { data: householdsRaw, error: householdsError } = await supabase
    .from("households")
    .select(
      `
      id,
      display_name,
      household_devices(
        role,
        devices(
          id,
          openems_component_id,
          edges(
            openems_edge_id
          )
        )
      )
    `
    )
    .eq("microgrid_id", billingPeriod.microgrid_id)
    .eq("household_devices.role", "primary_consumption_meter");

  if (householdsError) {
    return {
      kind: "fatal",
      status: 500,
      body: {
        error: `Error fetching households: ${householdsError.message}`,
      },
    };
  }

  const householdsAll = (householdsRaw ?? []) as unknown as HouseholdRow[];
  const householdNames = new Map<string, string>(
    householdsAll.map((h) => [h.id, h.display_name])
  );

  // Map: householdId → primary device row (or null if un-metered).
  type ResolvedDevice = {
    deviceId: string;
    edgeOpenemsId: string;
    componentId: string;
  };
  const householdToDevice = new Map<string, ResolvedDevice | null>();

  for (const h of householdsAll) {
    const primaryHD = h.household_devices.find(
      (hd) => hd.role === "primary_consumption_meter"
    );
    if (!primaryHD || !primaryHD.devices) {
      householdToDevice.set(h.id, null);
      continue;
    }
    const device = primaryHD.devices;
    const edge = device.edges;
    if (!edge?.openems_edge_id || !device.openems_component_id) {
      // Metered link exists but config is incomplete — treat as misconfig
      // for the OpenEMS path. A `manualReadings` override still wins and
      // routes the household through the manual path.
      householdToDevice.set(h.id, null);
      continue;
    }
    householdToDevice.set(h.id, {
      deviceId: device.id,
      edgeOpenemsId: edge.openems_edge_id,
      componentId: device.openems_component_id,
    });
  }

  // ── 4. Compute the processed household set ───────────────────────────────
  // - undefined → all microgrid households
  // - explicit list → use it, plus implicit add from manualReadings
  // - empty list (with no manualReadings) was caught above
  const manualByHousehold = new Map<string, ManualReadingInput>();
  for (const m of manualReadingsParam) {
    manualByHousehold.set(m.householdId, m);
  }

  const microgridHouseholdIdSet = new Set(householdsAll.map((h) => h.id));

  const baseSet =
    householdIdsParam === undefined
      ? new Set<string>(householdsAll.map((h) => h.id))
      : new Set<string>(householdIdsParam);

  // Implicit add from manualReadings.
  for (const id of manualByHousehold.keys()) {
    baseSet.add(id);
  }

  // ── 4b. Cross-microgrid attack defense ────────────────────────────────────
  // Any household id (from caller-supplied householdIds OR manualReadings)
  // that is NOT in the period's microgrid → surface as 'unknown_household'
  // and drop. This closes the cross-org smuggling attack at the route.
  const unknownHouseholdErrors: ErrorHouseholdResult[] = [];
  const processedSet = new Set<string>();
  for (const hid of baseSet) {
    if (!microgridHouseholdIdSet.has(hid)) {
      unknownHouseholdErrors.push({
        kind: "error",
        householdId: hid,
        householdName: hid,
        error: `Household ${hid} is not in this microgrid.`,
        code: "unknown_household",
      });
      continue;
    }
    processedSet.add(hid);
  }

  // ── 5. Fetch prior line items for this period (UPSERT preserve + previous*)
  // We need:
  //   - existing line items in THIS period (for previousTotalAmount /
  //     previousPaymentStatus / Q5 currently_manual detection)
  //   - prior-period end_kwh per device for start_kwh derivation
  const { data: existingItemsRaw } = await supabase
    .from("billing_line_items")
    .select(
      // The trailing fields (start_kwh, usage_kwh, tier_breakdown,
      // entered_by_user_id, entered_at, manual_reason) are read for #218's
      // `previous_snapshot` audit-details capture — the RPC overwrites them
      // on UPSERT-UPDATE, so we must read them BEFORE calling the RPC.
      "household_id, total_amount, payment_status, reading_source, end_kwh, device_id, start_kwh, usage_kwh, tier_breakdown, entered_by_user_id, entered_at, manual_reason"
    )
    .eq("billing_period_id", periodId);
  const existingByHousehold = new Map<string, PriorItem>();
  for (const r of (existingItemsRaw ?? []) as unknown as PriorItem[]) {
    existingByHousehold.set(r.household_id, r);
  }

  // Prior-period device → last end_kwh (start_kwh derivation).
  const deviceIdsForLookup: string[] = [];
  for (const hid of processedSet) {
    if (manualByHousehold.has(hid)) continue; // start/end come from override
    const dev = householdToDevice.get(hid);
    if (dev) deviceIdsForLookup.push(dev.deviceId);
  }
  const priorEndKwhMap = new Map<string, number>();
  if (deviceIdsForLookup.length > 0) {
    const { data: priorPeriods } = await supabase
      .from("billing_periods")
      .select("id")
      .eq("microgrid_id", billingPeriod.microgrid_id)
      .lte("end_date", billingPeriod.start_date)
      .neq("id", billingPeriod.id)
      .order("end_date", { ascending: false });
    if (priorPeriods && priorPeriods.length > 0) {
      const priorPeriodIds = priorPeriods.map((p) => p.id);
      const { data: priorItems } = await supabase
        .from("billing_line_items")
        .select("device_id, end_kwh, billing_period_id")
        .in("billing_period_id", priorPeriodIds)
        .in("device_id", deviceIdsForLookup)
        .not("end_kwh", "is", null);
      if (priorItems) {
        const periodOrder = new Map(priorPeriodIds.map((id, i) => [id, i]));
        priorItems.sort(
          (a, b) =>
            (periodOrder.get(a.billing_period_id) ?? 999) -
            (periodOrder.get(b.billing_period_id) ?? 999)
        );
        for (const item of priorItems) {
          if (item.device_id && !priorEndKwhMap.has(item.device_id)) {
            priorEndKwhMap.set(item.device_id, Number(item.end_kwh));
          }
        }
      }
    }
  }

  // ── 6. Resolve OpenEMS readings — only when at least one household needs them
  const householdsNeedingOpenems: string[] = [];
  for (const hid of processedSet) {
    if (manualByHousehold.has(hid)) continue;
    const dev = householdToDevice.get(hid);
    if (dev) householdsNeedingOpenems.push(hid);
  }

  let usageMap = new Map<string, number | null>();
  let openemsConfigMissing = false;
  let openemsFatal: RunGenerationFatal | null = null;
  if (householdsNeedingOpenems.length > 0) {
    let emsConfig;
    try {
      emsConfig = await getMicrogridEmsConfig(
        supabase,
        billingPeriod.microgrid_id
      );
    } catch (err) {
      if (err instanceof OpenEmsError) {
        // Per-household error — fall through, mark each metered household
        // missing_openems_config below.
        openemsConfigMissing = true;
      } else {
        throw err;
      }
    }
    if (!emsConfig && !openemsConfigMissing) {
      openemsConfigMissing = true;
    }

    if (emsConfig) {
      try {
        const client = createOpenEmsClient(emsConfig);
        const deviceConfigs: DeviceConfig[] = householdsNeedingOpenems
          .map((hid) => householdToDevice.get(hid))
          .filter((d): d is ResolvedDevice => Boolean(d))
          .map((d) => ({
            id: d.deviceId,
            edgeOpenemsId: d.edgeOpenemsId,
            componentId: d.componentId,
          }));
        // #355: the window's timezone is the PERIOD's stamped value
        // (`billing_periods.timezone`, written once by the BEFORE INSERT
        // trigger from #354) — never `microgrids.timezone`, which the
        // operator can change later. Regenerating a closed period after a
        // microgrid timezone change must reproduce the identical window and
        // therefore byte-identical line items; if the stamp trigger ever
        // starts re-stamping on UPDATE, revisit this guarantee.
        const readings = await client.getReadings(
          deviceConfigs,
          billingPeriod.start_date,
          billingPeriod.end_date,
          billingPeriod.timezone
        );
        usageMap = new Map<string, number | null>();
        for (const r of readings) usageMap.set(r.deviceId, r.usageKwh);
      } catch (err) {
        if (err instanceof OpenEmsError) {
          openemsFatal = {
            kind: "fatal",
            status: err.statusCode,
            body: { error: err.message, code: err.code },
          };
        } else {
          throw err;
        }
      }
    }

    if (openemsFatal) return openemsFatal;
  }

  // ── 7. Per-household processing loop ──────────────────────────────────────
  const results: HouseholdResult[] = [...unknownHouseholdErrors];

  for (const hid of processedSet) {
    const householdName = householdNames.get(hid) ?? hid;
    const prior = existingByHousehold.get(hid) ?? null;
    const dev = householdToDevice.get(hid);
    const manual = manualByHousehold.get(hid);

    // Q5: bulk-regenerate hit a manual row without a manual override → skip.
    if (
      manual === undefined &&
      prior?.reading_source === "manual" &&
      householdIdsParam !== undefined &&
      householdIdsParam.includes(hid)
    ) {
      results.push({
        kind: "error",
        householdId: hid,
        householdName,
        error:
          "Currently set to manual entry — use per-row regenerate to change.",
        code: "currently_manual",
      });
      continue;
    }

    // Resolve start_kwh / end_kwh / usage_kwh / reading_source / device_id.
    let startKwh: number;
    let endKwh: number;
    let usageKwh: number;
    let readingSource: ReadingSource;
    let deviceId: string | null;
    let manualReason: string | null = null;

    if (manual) {
      // Manual override path. AC3: usage_kwh is server-derived.
      // Defensive: re-validate end >= start (route Zod schema also catches).
      if (!Number.isFinite(manual.startKwh) || manual.startKwh < 0) {
        results.push({
          kind: "error",
          householdId: hid,
          householdName,
          error: "startKwh must be a non-negative finite number.",
          code: "invalid_manual_reading",
        });
        continue;
      }
      if (!Number.isFinite(manual.endKwh) || manual.endKwh < 0) {
        results.push({
          kind: "error",
          householdId: hid,
          householdName,
          error: "endKwh must be a non-negative finite number.",
          code: "invalid_manual_reading",
        });
        continue;
      }
      if (manual.endKwh < manual.startKwh) {
        results.push({
          kind: "error",
          householdId: hid,
          householdName,
          error: "endKwh must be greater than or equal to startKwh.",
          code: "invalid_manual_reading",
        });
        continue;
      }
      startKwh = manual.startKwh;
      endKwh = manual.endKwh;
      usageKwh = endKwh - startKwh;
      readingSource = "manual";
      // Manual rows can have a device_id (BC2/BC3 toggle metered → manual)
      // OR none (un-metered household). Preserve the metered link if there
      // is one — informational only; the manual reading is authoritative.
      deviceId = dev?.deviceId ?? null;
      manualReason = manual.reason ?? null;
    } else if (dev) {
      // Edge path — needs OpenEMS reading.
      if (openemsConfigMissing) {
        results.push({
          kind: "error",
          householdId: hid,
          householdName,
          error:
            "OpenEMS Backend not configured for this microgrid. Configure it on the OpenEMS Backend tab first.",
          code: "missing_openems_config",
        });
        continue;
      }
      const u = usageMap.get(dev.deviceId);
      if (u === null || u === undefined) {
        results.push({
          kind: "error",
          householdId: hid,
          householdName,
          error: "No meter reading data available",
          code: "no_meter_reading",
        });
        continue;
      }
      usageKwh = u;

      // #339. Three sources, in order, and NO zero default.
      //
      //   1. prior MBE end_kwh for this device — the running tally
      //   2. an operator seed — the meter was billed before it was connected
      //   3. neither → refuse; see needs_seed_reading
      //
      // The old `?? 0` converted "I have no record" into "the meter read
      // zero". Those are different claims and the second one gets printed on
      // an invoice the customer can check against the dial.
      //
      // A household-keyed fallback (the household's last end_kwh from rows
      // written before the device existed) is deliberately NOT a fourth
      // source. It is correct when a meter was connected and silently wrong
      // when a meter was replaced, and the two are indistinguishable in the
      // data — it would turn a visibly wrong 0 into a plausible wrong number.
      const priorEnd = priorEndKwhMap.get(dev.deviceId);
      const seed = seedByDevice.get(dev.deviceId);
      if (priorEnd != null) {
        startKwh = priorEnd;
      } else if (seed) {
        startKwh = seed.startKwh;
      } else {
        results.push({
          kind: "error",
          householdId: hid,
          householdName,
          error:
            "This meter was billed before it was connected to OpenEMS, so its starting reading is unknown.",
          code: "needs_seed_reading",
        });
        continue;
      }

      endKwh = startKwh + usageKwh;
      readingSource = "edge";
      deviceId = dev.deviceId;
    } else {
      // Un-metered household with no manual override: skip and report with
      // 'unmetered_no_manual'. This holds for BOTH the explicit dashboard
      // path (householdIds includes this id) AND the implicit pull-mode path
      // (householdIds === undefined) — #293.
      //
      // Pull-mode is an unattended cron. Writing a silent zeroed placeholder
      // row (start_kwh=0, end_kwh=0, usage_kwh=0) there mis-bills an un-metered
      // household as service-charge-only with no human in the loop; the only
      // signal is the response payload. Per Alejandro's decision (2026-07-01,
      // #293): no manual reading AND no OpenEMS data → do NOT bill; skip the
      // tenant and report it so the cron/caller sees it. The dashboard path
      // already emitted this same error; the two paths now agree.
      results.push({
        kind: "error",
        householdId: hid,
        householdName,
        error: "Household has no meter and no manual reading was supplied.",
        code: "unmetered_no_manual",
      });
      continue;
    }

    // Compute tier breakdown + total.
    const calc = calculateTieredCost(
      usageKwh,
      rateSchedule.tiers as TierConfig[],
      rateSchedule.service_charge,
      rateSchedule.tax_rate
    );

    // #227: round the reading-side numerics. `calc.tierBreakdown` and
    // `calc.totalAmount` are already rounded by calculateTieredCost.
    // Rounding here closes IEEE-754 dust from arithmetic like
    // `261.92 - 83.570 === 178.35000000000002` before the values land
    // in storage or in the preview payload.
    const startKwhRounded = roundKwh(startKwh);
    const endKwhRounded = roundKwh(endKwh);
    const usageKwhRounded = roundKwh(usageKwh);
    const previousTotalAmount =
      prior ? roundAmount(Number(prior.total_amount)) : null;

    if (mode === "preview") {
      results.push({
        kind: "preview",
        householdId: hid,
        householdName,
        startKwh: startKwhRounded,
        endKwh: endKwhRounded,
        usageKwh: usageKwhRounded,
        tierBreakdown: calc.tierBreakdown,
        totalAmount: calc.totalAmount,
        previousTotalAmount,
        previousPaymentStatus: prior?.payment_status ?? null,
      });
      continue;
    }

    // mode === 'write' — call the audit-aware RPC.
    const auditDetails: LineItemRegeneratedDetails = {
      household_name: householdName,
      previous_total_amount: previousTotalAmount,
      new_total_amount: calc.totalAmount,
      previous_reading_source: prior?.reading_source ?? null,
      new_reading_source: readingSource,
      ...(readingSource === "manual" && manualReason
        ? { manual_reason: manualReason }
        : {}),
      // #218: capture the reading-side snapshot of the row immediately BEFORE
      // this regeneration overwrites it. Present only on UPDATE (when prior
      // exists); absent on fresh INSERT. Numerics use `Number(x)`-or-null
      // coercion to match the existing previous_total_amount precision
      // pattern above. Note: `previous_snapshot.manual_reason` is the
      // PREVIOUS reason, distinct from the top-level `manual_reason` (NEW).
      ...(prior
        ? {
            previous_snapshot: {
              start_kwh:
                prior.start_kwh != null ? Number(prior.start_kwh) : null,
              end_kwh: prior.end_kwh != null ? Number(prior.end_kwh) : null,
              usage_kwh:
                prior.usage_kwh != null ? Number(prior.usage_kwh) : null,
              tier_breakdown: prior.tier_breakdown,
              device_id: prior.device_id,
              entered_by_user_id: prior.entered_by_user_id,
              entered_at: prior.entered_at,
              manual_reason: prior.manual_reason,
            },
          }
        : {}),
    };

    // SIGNATURE NOTE: this RPC's signature was widened in #250 (actor_kind,
    // actor_ref). PostgREST overload-resolution will reject DROP-less signature
    // changes with PGRST203. Any future param addition requires
    // `DROP FUNCTION IF EXISTS` in the migration BEFORE `CREATE OR REPLACE`.
    // See PR #209 / #250 for prior lessons.
    const { data: rpcRow, error: rpcErr } = await supabase.rpc(
      "fn_record_line_item_with_audit",
      {
        _billing_period_id: periodId,
        _household_id: hid,
        _device_id: deviceId,
        _usage_kwh: usageKwhRounded,
        _start_kwh: startKwhRounded,
        _end_kwh: endKwhRounded,
        _tier_breakdown: calc.tierBreakdown,
        _total_amount: calc.totalAmount,
        _reading_source: readingSource,
        _entered_by_user_id: actorUserId,
        _manual_reason: manualReason,
        _actor_user_id: actorUserId,
        _audit_details: auditDetails as unknown as Record<string, unknown>,
        _actor_kind: actorKind,
        _actor_ref: actorRef,
      }
    );

    if (rpcErr || !rpcRow) {
      results.push({
        kind: "error",
        householdId: hid,
        householdName,
        error: `Failed to write line item: ${rpcErr?.message ?? "unknown"}`,
        code: "no_meter_reading",
      });
      continue;
    }

    // Supabase RPC returning a composite row may surface as a single object
    // (PostgREST returns the row directly when the function returns a single
    // composite). Defensive coerce in case it arrives wrapped in an array.
    const writtenRowRaw = Array.isArray(rpcRow) ? rpcRow[0] : rpcRow;
    const writtenRow = writtenRowRaw as unknown as BillingLineItem;

    results.push({
      kind: "written",
      householdId: hid,
      householdName,
      lineItem: writtenRow,
      previousTotalAmount,
      previousPaymentStatus: prior?.payment_status ?? null,
      previousReadingSource: prior?.reading_source ?? null,
    });
  }

  return { results };
}
