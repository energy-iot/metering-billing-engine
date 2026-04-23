import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import { calculateTieredCost } from "@/lib/billing/calculations";
import type { BillingPeriod, RateSchedule } from "@/lib/types/domain";
import type { DeviceConfig } from "@/lib/adapters/types";

type GenerateRequestBody = {
  billingPeriodId: string;
};

type GenerateError = {
  householdId: string;
  householdName: string;
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

  // 3. Fetch households with their primary-consumption-meter device + parent edge
  //    in a single relational query. Post-#101: openems_backend_url lives on the
  //    microgrid, not the edge — so we don't select it per-device here.
  const { data: householdsRaw, error: householdsError } = await supabase
    .from("households")
    .select(`
      id,
      display_name,
      household_devices!inner(
        role,
        devices!inner(
          id,
          openems_component_id,
          edges!inner(
            openems_edge_id
          )
        )
      )
    `)
    .eq("microgrid_id", billingPeriod.microgrid_id)
    .eq("household_devices.role", "primary_consumption_meter");

  if (householdsError) {
    return NextResponse.json(
      { error: `Error fetching households: ${householdsError.message}` },
      { status: 500 }
    );
  }

  const errors: GenerateError[] = [];
  const deviceConfigs: DeviceConfig[] = [];

  // Map: deviceId → householdId (for line item assembly)
  const deviceToHouseholdMap = new Map<string, string>();

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
        };
      };
    }[];
  };

  for (const h of (householdsRaw ?? []) as unknown as HouseholdRow[]) {
    // Should have exactly one primary_consumption_meter due to partial unique index,
    // but iterate defensively.
    const primaryHD = h.household_devices.find(
      (hd) => hd.role === "primary_consumption_meter"
    );

    if (!primaryHD) {
      errors.push({
        householdId: h.id,
        householdName: h.display_name,
        error: "No primary_consumption_meter device assigned",
      });
      continue;
    }

    const device = primaryHD.devices;
    const edge = device.edges;

    if (!edge.openems_edge_id || !device.openems_component_id) {
      errors.push({
        householdId: h.id,
        householdName: h.display_name,
        error: "Device or parent edge is missing required OpenEMS config fields",
      });
      continue;
    }

    deviceConfigs.push({
      id: device.id,
      edgeOpenemsId: edge.openems_edge_id,
      componentId: device.openems_component_id,
    });
    deviceToHouseholdMap.set(device.id, h.id);
  }

  // Also build an id→display_name map for error reporting
  const householdNames = new Map<string, string>(
    ((householdsRaw ?? []) as unknown as HouseholdRow[]).map((h) => [h.id, h.display_name])
  );

  // 4. Look up prior-period end readings keyed on device_id
  const deviceIdsForGeneration = Array.from(deviceToHouseholdMap.keys());
  const priorEndKwhMap = new Map<string, number>();

  if (deviceIdsForGeneration.length > 0) {
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

      // Step B: Get line items from those periods with end_kwh set, keyed by device_id
      const { data: priorItems } = await supabase
        .from("billing_line_items")
        .select("device_id, end_kwh, billing_period_id")
        .in("billing_period_id", priorPeriodIds)
        .in("device_id", deviceIdsForGeneration)
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
          if (item.device_id && !priorEndKwhMap.has(item.device_id)) {
            priorEndKwhMap.set(item.device_id, Number(item.end_kwh));
          }
        }
      }
    }
  }

  if (deviceConfigs.length === 0) {
    // No devices to query — delete old line items and return
    await supabase
      .from("billing_line_items")
      .delete()
      .eq("billing_period_id", body.billingPeriodId);

    return NextResponse.json({ lineItems: 0, errors });
  }

  // 5. Call OpenEMS for readings. Resolve the microgrid-level config first
  //    — the billing_period already names the microgrid.
  let emsConfig;
  try {
    emsConfig = await getMicrogridEmsConfig(
      supabase,
      billingPeriod.microgrid_id
    );
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    throw err;
  }

  if (!emsConfig) {
    return NextResponse.json(
      {
        error:
          "OpenEMS Backend not configured for this microgrid. Configure it on the OpenEMS Backend tab first.",
      },
      { status: 409 }
    );
  }

  try {
    const client = createOpenEmsClient(emsConfig);
    const readings = await client.getReadings(
      deviceConfigs,
      billingPeriod.start_date,
      billingPeriod.end_date
    );

    // 6. Build deviceId → usageKwh map
    const usageMap = new Map<string, number | null>();
    for (const reading of readings) {
      usageMap.set(reading.deviceId, reading.usageKwh);
    }

    // 7. Calculate tier breakdown per household and build line items
    const lineItemRows: {
      billing_period_id: string;
      household_id: string;
      device_id: string;
      usage_kwh: number;
      start_kwh: number;
      end_kwh: number;
      tier_breakdown: { label: string; kwh: number; amount: number }[];
      total_amount: number;
    }[] = [];

    for (const [deviceId, householdId] of deviceToHouseholdMap) {
      const usageKwh = usageMap.get(deviceId);
      if (usageKwh === null || usageKwh === undefined) {
        errors.push({
          householdId,
          householdName: householdNames.get(householdId) ?? householdId,
          error: "No meter reading data available",
        });
        continue;
      }

      const calc = calculateTieredCost(
        usageKwh,
        rateSchedule.tiers as { label: string; min_kwh: number; max_kwh: number | null; rate_per_kwh: number }[],
        rateSchedule.service_charge,
        rateSchedule.tax_rate
      );

      const startKwh = priorEndKwhMap.get(deviceId) ?? 0;
      const endKwh = startKwh + usageKwh;

      lineItemRows.push({
        billing_period_id: body.billingPeriodId,
        household_id: householdId,
        device_id: deviceId,
        usage_kwh: usageKwh,
        start_kwh: startKwh,
        end_kwh: endKwh,
        tier_breakdown: calc.tierBreakdown,
        total_amount: calc.totalAmount,
      });
    }

    // 8. Delete existing line items
    await supabase
      .from("billing_line_items")
      .delete()
      .eq("billing_period_id", body.billingPeriodId);

    // 9. Insert new line items
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
