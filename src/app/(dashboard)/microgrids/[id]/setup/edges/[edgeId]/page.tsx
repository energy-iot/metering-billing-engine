import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type { Device, Edge, Household, HouseholdDevice } from "@/lib/types/domain";
import { StatusChip } from "@/components/ui/status-chip";
import { HierarchyNav } from "@/components/ui/hierarchy-nav";
import { getHierarchyLevels } from "@/lib/hierarchy";
import { DiscoverDevices } from "@/components/DiscoverDevices";
import { EdgeDetailConfigureButton } from "./edge-detail-configure-button";
import { DeleteEntityButton } from "@/components/forms/DeleteEntityButton";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { EmptyState } from "@/components/ui/empty-state";
import { createOpenEmsClient } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";
import type { OpenEmsClientConfig } from "@/lib/openems";

// Setup > Edges > [edgeId] — edge detail (D2 / #53, #77).
// Lists devices on this edge. For each device, shows the linked household
// (via household_devices) if any.
//
// #77 adds: "Configure…" button in the header (via client shell component).
// #139 adds: edge-online fetch for the empty-state tone (warn if offline).

async function fetchEdgeOnlineStatus(
  emsConfig: OpenEmsClientConfig | null,
  openemsEdgeId: string | null,
): Promise<boolean> {
  if (!emsConfig || !openemsEdgeId) return false;
  try {
    const client = createOpenEmsClient(emsConfig);
    const statuses = await client.getEdgesStatus([openemsEdgeId]);
    return statuses.find((s) => s.edgeId === openemsEdgeId)?.online === true;
  } catch (err) {
    void err; // treat fetch error as offline
    return false;
  }
}

type DeviceRow = Pick<
  Device,
  "id" | "name" | "device_type" | "openems_component_id"
>;
type HhRow = Pick<Household, "id" | "display_name">;
type HdRow = Pick<HouseholdDevice, "device_id" | "household_id" | "role">;

export default async function EdgeDetailPage({
  params,
}: {
  params: Promise<{ id: string; edgeId: string }>;
}) {
  const { id, edgeId } = await params;
  const supabase = await createClient();

  const levels = await getHierarchyLevels(supabase, {
    kind: "edge",
    microgridId: id,
    edgeId,
  });

  // Fetch the edge (scoped to this microgrid via `.eq("microgrid_id")`).
  const { data: edge, error: edgeError } = await supabase
    .from("edges")
    .select("*")
    .eq("id", edgeId)
    .eq("microgrid_id", id)
    .single<Edge>();

  if (edgeError || !edge) {
    notFound();
  }

  const canManage = await currentUserCanAccessMicrogrid(supabase, id);

  // Fetch edge online status for the devices empty-state tone (#139 P6).
  // Treat emsConfig fetch failure or missing openems_edge_id as offline.
  let emsConfig: OpenEmsClientConfig | null = null;
  try {
    emsConfig = await getMicrogridEmsConfig(supabase, id);
  } catch {
    emsConfig = null;
  }
  const edgeOnline = await fetchEdgeOnlineStatus(emsConfig, edge.openems_edge_id ?? null);

  const { data: devices, error: devicesError } = await supabase
    .from("devices")
    .select("id, name, device_type, openems_component_id")
    .eq("edge_id", edgeId)
    .order("name")
    .returns<DeviceRow[]>();

  const deviceIds = (devices ?? []).map((d) => d.id);

  const [hdsResult, hhsResult] = await Promise.all([
    deviceIds.length > 0
      ? supabase
          .from("household_devices")
          .select("device_id, household_id, role")
          .in("device_id", deviceIds)
          .returns<HdRow[]>()
      : Promise.resolve({ data: [] as HdRow[], error: null }),
    supabase
      .from("households")
      .select("id, display_name")
      .eq("microgrid_id", id)
      .returns<HhRow[]>(),
  ]);

  if (devicesError) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading devices: {devicesError.message}
      </div>
    );
  }

  const hhById: Record<string, string> = {};
  for (const h of hhsResult.data ?? []) hhById[h.id] = h.display_name;

  // Map device_id → primary_consumption_meter household_id (first match wins;
  // the schema allows other roles too, but the IA surfaces "billed household").
  const primaryByDevice: Record<string, string> = {};
  for (const hd of hdsResult.data ?? []) {
    if (hd.role === "primary_consumption_meter") {
      primaryByDevice[hd.device_id] = hd.household_id;
    }
  }

  return (
    <div className="space-y-4">
      <HierarchyNav levels={levels} className="mb-2" />
      <div>
        <Link
          href={`/microgrids/${id}/setup/edges`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to edges
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h3 className="text-lg font-semibold text-foreground">{edge.name}</h3>
          <StatusChip kind="edgeSource" status="openems" />
          {/* Client shell: Configure… button opens EdgeFormModal in edit mode.
              Gated on canManage per AC-PERM-1 (#104). */}
          {canManage && <EdgeDetailConfigureButton edge={edge} />}
          {canManage && (
            <DeleteEntityButton entity="edge" id={edge.id} name={edge.name} />
          )}
        </div>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          {edge.openems_edge_id ?? "—"}
        </p>
      </div>

      {/* Discover devices — available for every edge (OpenEMS is the only type post-#101) */}
      {edge.openems_edge_id && (
        <div className="rounded-lg border border-border bg-card p-6">
          <DiscoverDevices
            edgeDbId={edgeId}
            openemsEdgeId={edge.openems_edge_id}
          />
        </div>
      )}

      {(!devices || devices.length === 0) ? (
        edgeOnline ? (
          <EmptyState
            eyebrow="Devices"
            title="Run discovery to see meters"
            body={
              <>
                MBE pulls meters from this edge&apos;s OpenEMS backend. Make
                sure the edge is online, then click Discover.
              </>
            }
            footnote={
              canManage
                ? "The Discover devices card is above this section."
                : "Ask a super admin to run discovery on this edge."
            }
          />
        ) : (
          <EmptyState
            tone="warn"
            eyebrow="Devices"
            title="Edge is offline — can't discover yet"
            body={
              <>
                MBE pulls meters from this edge&apos;s OpenEMS backend. Bring{" "}
                <span className="font-medium text-foreground">{edge.name}</span>{" "}
                online, then run discovery.
              </>
            }
            footnote="Tip: check the edge hardware and confirm it's reporting to OpenEMS Backend."
          />
        )
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="w-full text-left text-sm">
            <thead className="bg-muted">
              <tr>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Device
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Type
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  OpenEMS component
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Linked household
                </th>
              </tr>
            </thead>
            <tbody>
              {devices.map((device) => {
                const householdId = primaryByDevice[device.id];
                const householdName = householdId
                  ? hhById[householdId] ?? "—"
                  : null;
                return (
                  <tr key={device.id} className="border-t border-border">
                    <td className="px-4 py-3 font-medium text-foreground">
                      {device.name}
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip
                        kind="deviceType"
                        status={device.device_type}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                      {device.openems_component_id ?? "—"}
                    </td>
                    <td className="px-4 py-3 text-sm text-foreground">
                      {householdName ?? (
                        <span className="text-muted-foreground">
                          Not linked
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
