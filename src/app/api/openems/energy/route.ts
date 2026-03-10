import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getOpenEmsClient, OpenEmsError } from "@/lib/openems";
import type { OpenEmsDataSourceConfig } from "@/lib/openems/types";
import type { Meter } from "@/lib/types/database";
import type { MeterEnergyResult } from "@/lib/openems/types";

type EnergyRequestBody = {
  meterIds: string[];
  fromDate: string;
  toDate: string;
};

type MeterError = {
  meterId: string;
  error: string;
};

export async function POST(request: NextRequest) {
  let body: EnergyRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 }
    );
  }

  if (!body.meterIds || !Array.isArray(body.meterIds) || body.meterIds.length === 0) {
    return NextResponse.json(
      { error: "meterIds must be a non-empty array" },
      { status: 400 }
    );
  }

  if (!body.fromDate || !body.toDate) {
    return NextResponse.json(
      { error: "fromDate and toDate are required (YYYY-MM-DD format)" },
      { status: 400 }
    );
  }

  // Look up meters from Supabase (respects RLS via server client)
  const supabase = await createClient();
  const { data: meters, error: dbError } = await supabase
    .from("meters")
    .select("*")
    .in("id", body.meterIds);

  if (dbError) {
    return NextResponse.json(
      { error: `Database error: ${dbError.message}` },
      { status: 500 }
    );
  }

  if (!meters || meters.length === 0) {
    return NextResponse.json(
      { error: "No meters found for the provided IDs" },
      { status: 404 }
    );
  }

  // Filter for openems-type meters and collect errors for non-openems ones
  const openEmsMeters: Meter[] = [];
  const errors: MeterError[] = [];

  for (const meter of meters as Meter[]) {
    if (meter.data_source_type !== "openems") {
      errors.push({
        meterId: meter.id,
        error: `Meter has unsupported data source type: ${meter.data_source_type}`,
      });
      continue;
    }

    const config = meter.data_source_config as OpenEmsDataSourceConfig;
    if (!config?.edgeId || !config?.channelAddress) {
      errors.push({
        meterId: meter.id,
        error: "Meter has invalid data_source_config: missing edgeId or channelAddress",
      });
      continue;
    }

    openEmsMeters.push(meter);
  }

  if (openEmsMeters.length === 0) {
    return NextResponse.json({ results: [], errors });
  }

  // Group by edgeId for batching
  const edgeGroups = new Map<string, { meterId: string; channelAddress: string }[]>();
  for (const meter of openEmsMeters) {
    const config = meter.data_source_config as OpenEmsDataSourceConfig;
    const group = edgeGroups.get(config.edgeId) ?? [];
    group.push({ meterId: meter.id, channelAddress: config.channelAddress });
    edgeGroups.set(config.edgeId, group);
  }

  try {
    const client = getOpenEmsClient();
    const results: MeterEnergyResult[] = [];

    const edgeQueries = Array.from(edgeGroups.entries()).map(
      async ([edgeId, meterInfos]) => {
        const channels = meterInfos.map((m) => m.channelAddress);
        const data = await client.queryHistoricEnergy(
          edgeId,
          channels,
          body.fromDate,
          body.toDate
        );

        for (const meterInfo of meterInfos) {
          const whValue = data[meterInfo.channelAddress] ?? null;
          results.push({
            meterId: meterInfo.meterId,
            edgeId,
            channelAddress: meterInfo.channelAddress,
            energyWh: whValue,
            energyKwh: whValue !== null ? whValue / 1000 : null,
          });
        }
      }
    );

    await Promise.all(edgeQueries);
    return NextResponse.json({ results, errors });
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code, results: [], errors },
        { status: err.statusCode }
      );
    }
    return NextResponse.json(
      { error: "Unexpected error querying energy data", results: [], errors },
      { status: 500 }
    );
  }
}
