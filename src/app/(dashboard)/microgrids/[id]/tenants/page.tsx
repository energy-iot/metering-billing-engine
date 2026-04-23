import { createClient } from "@/lib/supabase/server";
import type { Device, Household } from "@/lib/types/domain";
import { DeviceManager } from "@/components/DeviceManager";
import { HouseholdTable } from "@/components/HouseholdTable";

export default async function TenantsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [
    { data: households, error: householdsError },
    { data: devices, error: devicesError },
    { data: primaryAssignments, error: assignmentsError },
  ] = await Promise.all([
    supabase
      .from("households")
      .select("*")
      .eq("microgrid_id", id)
      .order("display_name")
      .returns<Household[]>(),
    supabase
      .from("devices")
      .select("*")
      .in(
        "edge_id",
        // Subquery: get edge IDs for this microgrid
        (
          await supabase
            .from("edges")
            .select("id")
            .eq("microgrid_id", id)
        ).data?.map((e) => e.id) ?? []
      )
      .order("name")
      .returns<Device[]>(),
    supabase
      .from("household_devices")
      .select("household_id, device_id")
      .eq("role", "primary_consumption_meter"),
  ]);

  if (householdsError || devicesError || assignmentsError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading data:{" "}
        {householdsError?.message ??
          devicesError?.message ??
          assignmentsError?.message}
      </div>
    );
  }

  // Build household_id → device_id map for primary_consumption_meter assignments
  const primaryDeviceAssignments: Record<string, string> = {};
  for (const row of primaryAssignments ?? []) {
    primaryDeviceAssignments[row.household_id] = row.device_id;
  }

  return (
    <div className="space-y-6">
      <DeviceManager
        microgridId={id}
        devices={devices ?? []}
        households={households ?? []}
      />
      <HouseholdTable
        microgridId={id}
        households={households ?? []}
        devices={devices ?? []}
        primaryDeviceAssignments={primaryDeviceAssignments}
      />
    </div>
  );
}
