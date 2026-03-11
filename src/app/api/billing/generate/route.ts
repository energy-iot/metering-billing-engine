import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { calculateTieredCost } from "@/lib/billing/calculations";
import type {
  BillingPeriod,
  Meter,
  RateSchedule,
  Tenant,
} from "@/lib/types/database";
import type { MeterConfig } from "@/lib/adapters/types";

type GenerateRequestBody = {
  billingPeriodId: string;
};

type GenerateError = {
  tenantId: string;
  tenantName: string;
  error: string;
};

export async function POST(request: NextRequest) {
  let body: GenerateRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.billingPeriodId) {
    return NextResponse.json(
      { error: "billingPeriodId is required" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // 1. Fetch billing period
  const { data: period, error: periodError } = await supabase
    .from("billing_periods")
    .select("*")
    .eq("id", body.billingPeriodId)
    .single();

  if (periodError || !period) {
    return NextResponse.json(
      { error: "Billing period not found" },
      { status: 404 }
    );
  }

  const billingPeriod = period as BillingPeriod;

  if (billingPeriod.status === "closed") {
    return NextResponse.json(
      { error: "Cannot generate line items for a closed billing period" },
      { status: 400 }
    );
  }

  // 2. Fetch rate schedule
  const { data: schedule, error: scheduleError } = await supabase
    .from("rate_schedules")
    .select("*")
    .eq("microgrid_id", billingPeriod.microgrid_id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (scheduleError || !schedule) {
    return NextResponse.json(
      { error: "No rate schedule found for this microgrid" },
      { status: 400 }
    );
  }

  const rateSchedule = schedule as RateSchedule;

  // 3. Fetch tenants
  const { data: tenants, error: tenantsError } = await supabase
    .from("tenants")
    .select("*")
    .eq("microgrid_id", billingPeriod.microgrid_id)
    .order("name");

  if (tenantsError) {
    return NextResponse.json(
      { error: `Error fetching tenants: ${tenantsError.message}` },
      { status: 500 }
    );
  }

  const tenantList = (tenants ?? []) as Tenant[];

  // 4. Fetch meters
  const { data: meters, error: metersError } = await supabase
    .from("meters")
    .select("*")
    .eq("microgrid_id", billingPeriod.microgrid_id);

  if (metersError) {
    return NextResponse.json(
      { error: `Error fetching meters: ${metersError.message}` },
      { status: 500 }
    );
  }

  const meterList = (meters ?? []) as Meter[];
  const meterMap = new Map(meterList.map((m) => [m.id, m]));

  // 5. Build MeterConfig array — skip tenants without meters
  const errors: GenerateError[] = [];
  const meterConfigs: MeterConfig[] = [];
  const tenantMeterMap = new Map<string, string>(); // meterId -> tenantId

  for (const tenant of tenantList) {
    if (!tenant.meter_id) {
      errors.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        error: "No meter assigned",
      });
      continue;
    }

    const meter = meterMap.get(tenant.meter_id);
    if (!meter) {
      errors.push({
        tenantId: tenant.id,
        tenantName: tenant.name,
        error: "Assigned meter not found",
      });
      continue;
    }

    meterConfigs.push({
      id: meter.id,
      dataSourceType: meter.data_source_type,
      dataSourceConfig: meter.data_source_config,
    });
    tenantMeterMap.set(meter.id, tenant.id);
  }

  // 5b. Collect meter IDs and look up prior-period end readings
  const meterIdsForGeneration = tenantList
    .filter((t) => t.meter_id && meterMap.has(t.meter_id))
    .map((t) => t.meter_id!);

  const priorEndKwhMap = new Map<string, number>();

  if (meterIdsForGeneration.length > 0) {
    // Step A: Get prior period IDs (end_date <= current start_date)
    const { data: priorPeriods } = await supabase
      .from("billing_periods")
      .select("id")
      .eq("microgrid_id", billingPeriod.microgrid_id)
      .lte("end_date", billingPeriod.start_date)
      .neq("id", billingPeriod.id)
      .order("end_date", { ascending: false });

    if (priorPeriods && priorPeriods.length > 0) {
      const priorPeriodIds = priorPeriods.map((p) => p.id);

      // Step B: Get line items from those periods with end_kwh set
      const { data: priorItems } = await supabase
        .from("billing_line_items")
        .select("meter_id, end_kwh, billing_period_id")
        .in("billing_period_id", priorPeriodIds)
        .in("meter_id", meterIdsForGeneration)
        .not("end_kwh", "is", null);

      if (priorItems) {
        const periodOrder = new Map(
          priorPeriodIds.map((id, i) => [id, i])
        );
        priorItems.sort(
          (a, b) =>
            (periodOrder.get(a.billing_period_id) ?? 999) -
            (periodOrder.get(b.billing_period_id) ?? 999)
        );
        for (const item of priorItems) {
          if (item.meter_id && !priorEndKwhMap.has(item.meter_id)) {
            priorEndKwhMap.set(item.meter_id, Number(item.end_kwh));
          }
        }
      }
    }
  }

  if (meterConfigs.length === 0 && tenantList.length > 0) {
    // No meters to query, but we still delete old line items
    await supabase
      .from("billing_line_items")
      .delete()
      .eq("billing_period_id", body.billingPeriodId);

    return NextResponse.json({ lineItems: 0, errors });
  }

  // 6. Call OpenEMS for readings
  try {
    const client = getOpenEmsClient();
    const readings = await client.getReadings(
      meterConfigs,
      billingPeriod.start_date,
      billingPeriod.end_date
    );

    // 7. Build meterId -> usageKwh map
    const usageMap = new Map<string, number | null>();
    for (const reading of readings) {
      usageMap.set(reading.meterId, reading.usageKwh);
    }

    // 8. Calculate tier breakdown per tenant and build line items
    const lineItemRows: {
      billing_period_id: string;
      tenant_id: string;
      meter_id: string;
      usage_kwh: number;
      start_kwh: number;
      end_kwh: number;
      tier_breakdown: { label: string; kwh: number; amount: number }[];
      total_amount: number;
    }[] = [];

    for (const tenant of tenantList) {
      if (!tenant.meter_id) continue; // already in errors

      const usageKwh = usageMap.get(tenant.meter_id);
      if (usageKwh === null || usageKwh === undefined) {
        errors.push({
          tenantId: tenant.id,
          tenantName: tenant.name,
          error: "No meter reading data available",
        });
        continue;
      }

      const calc = calculateTieredCost(
        usageKwh,
        rateSchedule.tiers,
        rateSchedule.service_charge,
        rateSchedule.tax_rate
      );

      const startKwh = priorEndKwhMap.get(tenant.meter_id!) ?? 0;
      const endKwh = startKwh + usageKwh;

      lineItemRows.push({
        billing_period_id: body.billingPeriodId,
        tenant_id: tenant.id,
        meter_id: tenant.meter_id,
        usage_kwh: usageKwh,
        start_kwh: startKwh,
        end_kwh: endKwh,
        tier_breakdown: calc.tierBreakdown,
        total_amount: calc.totalAmount,
      });
    }

    // 9. Delete existing line items
    await supabase
      .from("billing_line_items")
      .delete()
      .eq("billing_period_id", body.billingPeriodId);

    // 10. Insert new line items
    if (lineItemRows.length > 0) {
      const { error: insertError } = await supabase
        .from("billing_line_items")
        .insert(lineItemRows);

      if (insertError) {
        return NextResponse.json(
          { error: `Failed to insert line items: ${insertError.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      lineItems: lineItemRows.length,
      errors,
    });
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Unexpected error generating billing data" },
      { status: 500 }
    );
  }
}
