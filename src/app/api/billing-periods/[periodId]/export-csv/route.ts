/**
 * GET /api/billing-periods/[periodId]/export-csv
 *
 * #229 — Operator-facing CSV download for URA filing. Bundles every
 * line item in the period into a single CSV that Aaron pastes
 * row-by-row into URA's online portal (via Excel as an intermediary).
 *
 * Pattern (mirrors PDF1b at `src/app/api/billing-line-items/[lineItemId]/pdf/route.ts`):
 *   - UUID parse → 400.
 *   - Session-bound Supabase client (`@/lib/supabase/server`) for the
 *     auth fetch + row read. RLS is the access gate.
 *   - Permission ordering: row read → 404 if RLS-hidden → defense-in-depth
 *     `currentUserCanAccessMicrogrid` → 403.
 *   - Service-role client used ONLY for the joins (households, devices,
 *     rate schedule) so the export does not depend on RLS visibility for
 *     joined rows; the access gate above already authorized the period.
 *   - Most-recent rate_schedule per microgrid (`ORDER BY created_at DESC LIMIT 1`).
 *   - Microgrid SELECT goes through `MICROGRID_PUBLIC_COLUMNS` (no
 *     `.select("*")`).
 *   - Works on both `draft` and `closed` periods.
 *   - Headers: `text/csv; charset=utf-8`, sanitized
 *     `Content-Disposition: attachment; filename="…"`, `Cache-Control: no-store`.
 *
 * The CSV body itself is built by the pure helper
 * `src/lib/billing/csv-export.ts` — this route's job is purely the
 * permission gate, the join assembly, and the response wiring.
 */

import { NextRequest, NextResponse } from "next/server";

import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import {
  buildBillingPeriodCsv,
  buildCsvFilename,
  type CsvExportInput,
  type CsvExportRow,
} from "@/lib/billing/csv-export";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type DeviceJoinRow = {
  household_id: string;
  // PostgREST !inner returns the join as either `T` or `T[]` depending
  // on cardinality + rest version; the unwrap helper below normalizes.
  devices:
    | { openems_component_id: string | null }
    | Array<{ openems_component_id: string | null }>
    | null;
};

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ periodId: string }> },
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { periodId } = await params;

  if (!UUID_RE.test(periodId)) {
    return NextResponse.json(
      {
        error: "Invalid billing period id — expected UUID.",
        reason: "bad_request",
      },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // 1. Auth gate.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Unauthorized.", reason: "unauthorized" },
      { status: 401 },
    );
  }

  // 2. Resolve the billing period (RLS-scoped to caller). RLS-hidden or
  //    missing → 404.
  const { data: periodRow, error: periodErr } = await supabase
    .from("billing_periods")
    .select("id, microgrid_id, start_date, end_date, status")
    .eq("id", periodId)
    .maybeSingle();

  if (periodErr) {
    return NextResponse.json(
      {
        error: `Failed to look up billing period: ${periodErr.message}`,
        reason: "unknown_error",
      },
      { status: 500 },
    );
  }
  if (!periodRow) {
    return NextResponse.json(
      { error: "Billing period not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  const microgridId = periodRow.microgrid_id as string;

  // 3. Defense-in-depth permission check (production-wise RLS already
  //    404'd cross-org rows; this branch is exercised by mocked tests).
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return NextResponse.json(
      {
        error: "You do not have permission to export this billing period.",
        reason: "forbidden",
      },
      { status: 403 },
    );
  }

  // 4. Service-role client for the joins. Authorization is already
  //    decided above; service-role here avoids per-row RLS evaluation
  //    on the join graph.
  const svc = createServiceClient();

  // 4a. Microgrid (enumerated columns via MICROGRID_PUBLIC_COLUMNS).
  const { data: microgridRaw, error: microgridErr } = await svc
    .from("microgrids")
    .select(`${MICROGRID_PUBLIC_COLUMNS}, communities!inner(id, invoice_config)`)
    .eq("id", microgridId)
    .maybeSingle();

  if (microgridErr || !microgridRaw) {
    return NextResponse.json(
      {
        error: `Failed to load microgrid: ${microgridErr?.message ?? "not found"}`,
        reason: "unknown_error",
      },
      { status: 500 },
    );
  }

  const microgridRow = microgridRaw as unknown as Record<string, unknown>;
  const communityRaw = unwrap(microgridRow.communities);
  const microgridName = (microgridRow.name as string | null) ?? "microgrid";
  const microgridCurrency = (microgridRow.currency as string | null) ?? "UGX";
  const invoiceConfigRaw =
    (communityRaw?.invoice_config as Record<string, unknown> | null) ?? null;
  const taxRaw =
    (invoiceConfigRaw?.tax as Record<string, unknown> | undefined) ?? null;
  const showSection =
    taxRaw && typeof taxRaw.show_section === "boolean"
      ? (taxRaw.show_section as boolean)
      : true;
  const ratePct =
    taxRaw && typeof taxRaw.rate_pct === "number"
      ? (taxRaw.rate_pct as number)
      : 0;

  // 4b. Most-recent rate schedule for the microgrid.
  const { data: rsRow, error: rsErr } = await svc
    .from("rate_schedules")
    .select("tiers, service_charge, tax_rate, created_at")
    .eq("microgrid_id", microgridId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (rsErr || !rsRow) {
    return NextResponse.json(
      {
        error:
          "Cannot export — no rate schedule configured for this microgrid.",
        reason: "missing_rate_schedule",
      },
      { status: 422 },
    );
  }

  const rateScheduleTiers =
    (rsRow.tiers as Array<{
      label: string;
      min_kwh: number;
      max_kwh: number | null;
      rate_per_kwh: number;
    }> | null) ?? [];
  const rateScheduleServiceCharge = (rsRow.service_charge as number) ?? 0;
  const rateScheduleTaxRate = (rsRow.tax_rate as number) ?? 0;

  // 4c. Line items + joined household. LEFT-join devices via
  //     household_devices on role='primary_consumption_meter'.
  const { data: lineItemRows, error: liErr } = await svc
    .from("billing_line_items")
    .select(
      `
      id,
      invoice_number,
      created_at,
      start_kwh,
      end_kwh,
      usage_kwh,
      tier_breakdown,
      total_amount,
      payment_status,
      paid_at,
      household_id,
      households!inner (
        id,
        display_name,
        account_number,
        meter_serial,
        meter_type,
        customer_type,
        unit_label,
        address_line1,
        address_line2,
        address_city,
        address_country,
        primary_phone
      )
    `,
    )
    .eq("billing_period_id", periodId);

  if (liErr) {
    return NextResponse.json(
      {
        error: `Failed to load billing line items: ${liErr.message}`,
        reason: "unknown_error",
      },
      { status: 500 },
    );
  }

  const liRows = (lineItemRows ?? []) as Array<Record<string, unknown>>;

  // 4d. Resolve a primary_consumption_meter device per household
  //     (separate query — simpler than nesting through household_devices
  //     in the line-items select).
  const householdIds = Array.from(
    new Set(
      liRows
        .map((r) => r.household_id as string | null)
        .filter((id): id is string => typeof id === "string"),
    ),
  );

  const deviceByHouseholdId = new Map<
    string,
    { openems_component_id: string | null }
  >();
  if (householdIds.length > 0) {
    const { data: devRows } = await svc
      .from("household_devices")
      .select(
        `
        household_id,
        devices!inner (
          openems_component_id
        )
      `,
      )
      .in("household_id", householdIds)
      .eq("role", "primary_consumption_meter");

    for (const row of (devRows ?? []) as DeviceJoinRow[]) {
      const dev = unwrap(row.devices as unknown);
      if (dev && row.household_id && !deviceByHouseholdId.has(row.household_id)) {
        deviceByHouseholdId.set(row.household_id, {
          openems_component_id:
            (dev.openems_component_id as string | null) ?? null,
        });
      }
    }
  }

  // 5. Assemble helper input.
  const rows: CsvExportRow[] = liRows.map((row) => {
    const hh = unwrap(row.households) ?? {};
    const householdId = (row.household_id as string | null) ?? null;
    const device = householdId
      ? deviceByHouseholdId.get(householdId) ?? null
      : null;
    return {
      household: {
        display_name: (hh.display_name as string | null) ?? "",
        account_number: (hh.account_number as string | null) ?? null,
        meter_serial: (hh.meter_serial as string | null) ?? null,
        meter_type: (hh.meter_type as string | null) ?? "",
        customer_type: (hh.customer_type as string | null) ?? "",
        unit_label: (hh.unit_label as string | null) ?? null,
        address_line1: (hh.address_line1 as string | null) ?? null,
        address_line2: (hh.address_line2 as string | null) ?? null,
        address_city: (hh.address_city as string | null) ?? null,
        address_country: (hh.address_country as string | null) ?? null,
        primary_phone: (hh.primary_phone as string | null) ?? null,
      },
      device: device ? { openems_component_id: device.openems_component_id } : null,
      lineItem: {
        id: row.id as string,
        invoice_number: (row.invoice_number as string | null) ?? null,
        created_at: (row.created_at as string | null) ?? "",
        start_kwh: (row.start_kwh as number | null) ?? null,
        end_kwh: (row.end_kwh as number | null) ?? null,
        usage_kwh: (row.usage_kwh as number | null) ?? null,
        tier_breakdown:
          (row.tier_breakdown as Array<{
            label: string;
            kwh: number;
            amount: number;
          }> | null) ?? [],
        total_amount: (row.total_amount as number) ?? 0,
        payment_status: (row.payment_status as string) ?? "unpaid",
        paid_at: (row.paid_at as string | null) ?? null,
      },
    };
  });

  const helperInput: CsvExportInput = {
    microgrid: { name: microgridName, currency: microgridCurrency },
    period: {
      id: periodRow.id as string,
      start_date: periodRow.start_date as string,
      end_date: periodRow.end_date as string,
      status: periodRow.status as string,
    },
    rateSchedule: {
      tiers: rateScheduleTiers,
      service_charge: rateScheduleServiceCharge,
      tax_rate: rateScheduleTaxRate,
    },
    invoiceConfig: {
      tax: { show_section: showSection, rate_pct: ratePct },
    },
    rows,
  };

  const csv = buildBillingPeriodCsv(helperInput);
  const csvBytes = Buffer.from(csv, "utf-8");

  const filename = buildCsvFilename({
    microgridName,
    startDate: periodRow.start_date as string,
    endDate: periodRow.end_date as string,
  });

  // 6. Forensic log — NO PII (no household names, addresses, phones, or
  //    line-item amounts).
  console.info(
    JSON.stringify(
      scrubSecretValues(
        {
          event: "billing.csv.exported",
          period_id: periodId,
          microgrid_id: microgridId,
          household_count: rows.length,
          byte_size: csvBytes.byteLength,
          duration_ms: Date.now() - startedAt,
          actor_user_id: user.id,
          at: new Date().toISOString(),
        },
        {},
      ),
    ),
  );

  return new NextResponse(new Uint8Array(csvBytes), {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

/** PostgREST !inner relations sometimes deserialize as `T[]` instead of
 * `T`. Normalize to `T | null`. */
function unwrap(candidate: unknown): Record<string, unknown> | null {
  if (candidate == null) return null;
  if (Array.isArray(candidate)) {
    return (candidate[0] ?? null) as Record<string, unknown> | null;
  }
  return candidate as Record<string, unknown>;
}
