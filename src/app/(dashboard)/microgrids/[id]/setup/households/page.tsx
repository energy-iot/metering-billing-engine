import { createClient } from "@/lib/supabase/server";
import type { Device, Household } from "@/lib/types/domain";
import { HouseholdsSection } from "./households-section";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";

// Setup > Households (D2 / #53).
// Lists households for this microgrid and exposes an "Add household" modal
// with the six AB fields (display_name, primary_phone, primary_email,
// address_line1, address_line2, unit_label). The polished 4-step wizard is
// a separate future ticket.

export default async function SetupHouseholdsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const levels = await getHierarchyLevels(supabase, {
    kind: "households-listing",
    microgridId: id,
  });

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
        (
          await supabase
            .from("edges")
            .select("id")
            .eq("microgrid_id", id)
        ).data?.map((e) => e.id) ?? [],
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

  const primaryDeviceAssignments: Record<string, string> = {};
  for (const row of primaryAssignments ?? []) {
    primaryDeviceAssignments[row.household_id] = row.device_id;
  }

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />
      <HouseholdsSection
        microgridId={id}
        households={households ?? []}
        devices={devices ?? []}
        primaryDeviceAssignments={primaryDeviceAssignments}
      />
    </>
  );
}
