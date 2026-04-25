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

  // 3. Fetch households + their primary-consumption-meter device + parent
  //    edge. #158 widens this from an INNER join to a LEFT join so un-metered
  //    households are returned alongside metered ones — they just arrive with
  //    an empty `household_devices` array. Concrete change: drop `!inner` on
  //    both `household_devices` and `devices` and add a filter on the join
  //    predicate so the include set is unchanged for metered households.
  //
  //    Post-#101: openems_backend_url lives on the microgrid, not the edge —
  //    so we don't select it per-device here.
  const { data: householdsRaw, error: householdsError } = await supabase
    .from("households")
    .select(`
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

  // #158: track households that have NO primary_consumption_meter link.
  // These get null-device "manual entry pending" line items inserted alongside
  // the metered rows so Aaron can fill them in from the BillingTable.
  const unmeteredHouseholdIds: string[] = [];

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

  for (const h of (householdsRaw ?? []) as unknown as HouseholdRow[]) {
    // Should have at most one primary_consumption_meter due to the partial
    // unique index. The LEFT join may surface zero rows for un-metered
    // households — those go to the manual-billing path.
    const primaryHD = h.household_devices.find(
      (hd) => hd.role === "primary_consumption_meter"
    );

    if (!primaryHD) {
      // #158: no meter linked — manual-billing path. We still emit a
      // line-item row with null device + null usage so the BillingTable
      // surfaces the household and the operator can enter usage by hand.
      unmeteredHouseholdIds.push(h.id);
      continue;
    }

    const device = primaryHD.devices;
    if (!device) {
      // Defensive: a household_devices row with role=primary_consumption_meter
      // but a nullable joined `devices` payload means the device row was
      // dropped underneath us. Treat as un-metered for this run.
      unmeteredHouseholdIds.push(h.id);
      continue;
    }
    const edge = device.edges;

    if (!edge || !edge.openems_edge_id || !device.openems_component_id) {
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

  // #158: shape an "unmetered placeholder" row per un-metered household.
  // These rows have null device_id, null end_kwh, null usage_kwh,
  // empty tier_breakdown, and total_amount=0. Aaron fills end/usage in
  // manually from the BillingTable; the PATCH /usage route then recomputes
  // tier_breakdown + total_amount via calculateTieredCost.
  type UnmeteredLineItem = {
    billing_period_id: string;
    household_id: string;
    device_id: null;
    usage_kwh: null;
    start_kwh: number;
    end_kwh: null;
    tier_breakdown: { label: string; kwh: number; amount: number }[];
    total_amount: number;
  };
  const unmeteredLineItems: UnmeteredLineItem[] = unmeteredHouseholdIds.map(
    (householdId) => ({
      billing_period_id: body.billingPeriodId,
      household_id: householdId,
      device_id: null,
      usage_kwh: null,
      // start_kwh stays 0 for un-metered rows: the manual entry IS the
      // usage_kwh, and end_kwh - start_kwh = usage_kwh holds when
      // start_kwh=0 + end_kwh=usage_kwh. Aaron can edit either field.
      start_kwh: 0,
      end_kwh: null,
      tier_breakdown: [],
      total_amount: 0,
    })
  );

  if (deviceConfigs.length === 0) {
    // No metered devices to query. Still delete-then-insert the unmetered
    // placeholders so re-runs don't accumulate stale rows.
    await supabase
      .from("billing_line_items")
      .delete()
      .eq("billing_period_id", body.billingPeriodId);

    if (unmeteredLineItems.length > 0) {
      const { error: insertError } = await supabase
        .from("billing_line_items")
        .insert(unmeteredLineItems);

      if (insertError) {
        return NextResponse.json(
          { error: `Failed to insert manual-billing line items: ${insertError.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      lineItems: unmeteredLineItems.length,
      errors,
    });
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

    // 9. Insert new line items — metered rows (from OpenEMS) + un-metered
    //    placeholder rows (for households with no primary meter linked).
    //    The two are inserted together so the delete-then-insert pattern
    //    stays atomic from the operator's POV.
    const allRows = [...lineItemRows, ...unmeteredLineItems];
    if (allRows.length > 0) {
      const { error: insertError } = await supabase
        .from("billing_line_items")
        .insert(allRows);

      if (insertError) {
        return NextResponse.json(
          { error: `Failed to insert line items: ${insertError.message}` },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({
      lineItems: allRows.length,
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
