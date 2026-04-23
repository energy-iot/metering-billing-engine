import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import type { Device } from "@/lib/types/domain";
import { StatusChip } from "@/components/ui/status-chip";

// Setup > Edges > Shared (D2 / #53).
// Devices on this microgrid's edges that are NOT linked to any household.
// Backed by the `microgrid_shared_devices` VIEW (see 00004_views.sql).
//
// Security note: the view is declared with `security_invoker = true`,
// so Supabase's row-level security policies on the underlying `devices`
// + `edges` tables are enforced as the CALLER, not as the view owner.

type SharedDeviceRow = Pick<
  Device,
  "id" | "name" | "device_type" | "openems_component_id" | "edge_id"
> & { microgrid_id: string };

export default async function SharedDevicesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const { data: sharedDevices, error: devErr } = await supabase
    .from("microgrid_shared_devices")
    .select("id, name, device_type, openems_component_id, edge_id, microgrid_id")
    .eq("microgrid_id", id)
    .order("name")
    .returns<SharedDeviceRow[]>();

  if (devErr) {
    return (
      <div className="rounded-md bg-destructive-muted p-4 text-sm text-destructive-fg">
        Error loading shared devices: {devErr.message}
      </div>
    );
  }

  // Fetch edge names for the devices we found, so we can display the edge name.
  const edgeIds = Array.from(new Set((sharedDevices ?? []).map((d) => d.edge_id)));
  const { data: edges } = edgeIds.length
    ? await supabase
        .from("edges")
        .select("id, name")
        .in("id", edgeIds)
    : { data: [] as { id: string; name: string }[] };

  const edgeNameById: Record<string, string> = {};
  for (const e of edges ?? []) edgeNameById[e.id] = e.name;

  return (
    <div className="space-y-4">
      <div>
        <Link
          href={`/microgrids/${id}/setup/edges`}
          className="text-xs text-muted-foreground hover:text-foreground"
        >
          ← Back to edges
        </Link>
        <h3 className="mt-2 text-lg font-semibold text-foreground">
          Shared devices
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Devices on this microgrid&apos;s edges that are not linked to any
          household. Typical examples: grid meter, PV inverter, battery.
        </p>
      </div>

      {(!sharedDevices || sharedDevices.length === 0) ? (
        <p className="rounded-md border border-border bg-card p-6 text-sm text-muted-foreground">
          All devices on this microgrid are linked to a household. No shared
          devices to show.
        </p>
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
                  Edge
                </th>
                <th className="px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  OpenEMS component
                </th>
              </tr>
            </thead>
            <tbody>
              {sharedDevices.map((device) => (
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
                  <td className="px-4 py-3 text-sm text-foreground">
                    <Link
                      href={`/microgrids/${id}/setup/edges/${device.edge_id}`}
                      className="hover:underline"
                    >
                      {edgeNameById[device.edge_id] ?? device.edge_id}
                    </Link>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-muted-foreground">
                    {device.openems_component_id ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
