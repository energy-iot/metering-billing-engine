import { createClient } from "@/lib/supabase/server";
import type { Device, Household } from "@/lib/types/domain";
import { HouseholdsSection } from "./households-section";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import type { AvailableMeter } from "@/components/forms/HouseholdWizard";
import type { BillingDeviceOption } from "@/components/HouseholdTable";

// Setup > Households (D2 / #53, upgraded in UX2 / #74).
// Lists households for this microgrid and exposes the 4-step Add-Household
// wizard. The wizard covers all six household fields PLUS a mandatory
// primary_consumption_meter assignment. Available-meters are fetched here
// server-side and passed as a prop to avoid leaking any cross-org data.

export default async function SetupHouseholdsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [canManage, levels] = await Promise.all([
    currentUserCanAccessMicrogrid(supabase, id),
    getHierarchyLevels(supabase, {
      kind: "households-listing",
      microgridId: id,
    }),
  ]);

  const [
    { data: households, error: householdsError },
    { data: devices, error: devicesError },
    { data: primaryAssignments, error: assignmentsError },
    { data: edgesForMg, error: edgesError },
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
    supabase
      .from("edges")
      .select("id, name")
      .eq("microgrid_id", id),
  ]);

  if (householdsError || devicesError || assignmentsError || edgesError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading data:{" "}
        {householdsError?.message ??
          devicesError?.message ??
          assignmentsError?.message ??
          edgesError?.message}
      </div>
    );
  }

  const primaryDeviceAssignments: Record<string, string> = {};
  for (const row of primaryAssignments ?? []) {
    primaryDeviceAssignments[row.household_id] = row.device_id;
  }

  // Build the set of device_ids already assigned as primary_consumption_meter
  // so we can exclude them from the wizard's available-meters list. The
  // server-side RLS scope ensures we only see household_devices rows within
  // this user's accessible orgs, but we additionally filter by this
  // microgrid's edges below.
  const assignedPrimaryDeviceIds = new Set(
    (primaryAssignments ?? []).map((r) => r.device_id)
  );

  const edgeNameById = new Map<string, string>(
    (edgesForMg ?? []).map((e) => [e.id, e.name ?? ""])
  );

  const availableMeters: AvailableMeter[] = (devices ?? [])
    .filter(
      (d) =>
        d.device_type === "consumption_meter" &&
        !assignedPrimaryDeviceIds.has(d.id)
    )
    .map((d) => ({
      id: d.id,
      name: d.name,
      device_type: d.device_type,
      edge_name: edgeNameById.get(d.edge_id) ?? "",
    }))
    // Sort by (edge_name, device name) as per the spec query.
    .sort((a, b) => {
      const e = a.edge_name.localeCompare(b.edge_name);
      return e !== 0 ? e : a.name.localeCompare(b.name);
    });

  // Build a map of household_id → display_name so we can resolve linked-to
  // household names for the billing-device <select>.
  const householdNameById = new Map<string, string>(
    (households ?? []).map((h) => [h.id, h.display_name])
  );
  // device_id → household display_name for devices already assigned somewhere
  const deviceLinkedHouseholdName = new Map<string, string>(
    (primaryAssignments ?? []).map((r) => [
      r.device_id,
      householdNameById.get(r.household_id) ?? r.household_id,
    ])
  );

  // BillingDeviceOptions: ALL devices on this microgrid (not just unassigned),
  // enriched with edge_name and (when assigned elsewhere) linkedToHouseholdName.
  // HouseholdTable is responsible for suppressing the "linked" label on the
  // device that is the CURRENT row's own assignment.
  const billingDevices: BillingDeviceOption[] = (devices ?? []).map((d) => ({
    id: d.id,
    name: d.name,
    device_type: d.device_type,
    edge_id: d.edge_id,
    edge_name: edgeNameById.get(d.edge_id) ?? "",
    linkedToHouseholdName: deviceLinkedHouseholdName.get(d.id),
  }));

  return (
    <>
      <HierarchyNav levels={levels} className="mb-4" />
      <HouseholdsSection
        microgridId={id}
        households={households ?? []}
        devices={devices ?? []}
        primaryDeviceAssignments={primaryDeviceAssignments}
        availableMeters={availableMeters}
        billingDevices={billingDevices}
        canManage={canManage}
      />
    </>
  );
}
