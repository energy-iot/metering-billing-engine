"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Device, Household } from "@/lib/types/domain";
import type {
  DiscoveredDevice,
  EdgeDiscoveryResult,
} from "@/lib/openems/types";
import { DEVICE_TYPE_INFO } from "@/lib/openems/device-descriptions";
import { StatusChip } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * DeviceManager — manages OpenEMS devices (formerly MeterManager).
 *
 * Devices are now first-class entities linked to edges in the DB. The
 * discovery flow reads from the OpenEMS edge config and inserts into the
 * `devices` table (linked to an `edges` row by edge_id).
 */
export function DeviceManager({
  microgridId,
  devices,
  households,
}: {
  microgridId: string;
  devices: Device[];
  households: Household[];
}) {
  const router = useRouter();
  const supabase = createClient();

  const [showDiscovery, setShowDiscovery] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discovery state
  const [discoveryResults, setDiscoveryResults] = useState<
    EdgeDiscoveryResult[]
  >([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [addingDevice, setAddingDevice] = useState<string | null>(null);
  // Optimistic tracking of devices added during this session (before router.refresh() completes)
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());

  // Friendly name input state
  const [namingDeviceId, setNamingDeviceId] = useState<string | null>(null);
  const [namingValue, setNamingValue] = useState("");

  // Delete dialog state
  const [deviceToDelete, setDeviceToDelete] = useState<Device | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Build set of already-added device component keys for dedup (prop-based + optimistic)
  const existingKeys = new Set([
    ...devices
      .filter((d) => d.openems_component_id)
      .map((d) => d.openems_component_id as string),
    ...addedKeys,
  ]);

  function openDeleteDialog(device: Device) {
    setDeviceToDelete(device);
    setDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!deviceToDelete) return;
    const { error: deleteError } = await supabase
      .from("devices")
      .delete()
      .eq("id", deviceToDelete.id);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    router.refresh();
  }

  // Build delete dialog description
  const deleteDescription = deviceToDelete
    ? (() => {
        const assignedHouseholds = households.filter(() => {
          // Note: actual assignment lookup is via household_devices join table;
          // this is a UI affordance — the authoritative check is server-side.
          return false; // placeholder: no direct FK on household to device
        });
        return assignedHouseholds.length > 0
          ? `This device is assigned to: ${assignedHouseholds.map((h) => h.display_name).join(", ")}. Deleting it will unassign their billing device.`
          : `Delete "${deviceToDelete.name}"?`;
      })()
    : undefined;

  async function handleDiscover() {
    setShowDiscovery(true);
    setDiscoveryError(null);
    setDiscoveryLoading(true);

    // For discovery, we use "edge0" as the default edge ID.
    // In a future ticket, this will be replaced with edge selection from DB.
    const edgeIds = "edge0";

    try {
      const res = await fetch(
        `/api/openems/discover?edgeIds=${encodeURIComponent(edgeIds)}`
      );
      const data = await res.json();

      if (!res.ok) {
        setDiscoveryError(data.error || "Failed to discover devices");
        setDiscoveryResults([]);
        return;
      }

      setDiscoveryResults(data.edges ?? []);
    } catch {
      setDiscoveryError(
        "Could not reach the server. Check your network connection."
      );
      setDiscoveryResults([]);
    } finally {
      setDiscoveryLoading(false);
    }
  }

  async function handleAddDiscovered(
    discoveredEdgeId: string,
    device: DiscoveredDevice
  ) {
    if (!namingValue.trim()) return;

    setAddingDevice(device.componentId);
    setError(null);

    // Find the edge row in DB by openems_edge_id + microgrid_id.
    // For now we look up the edge_id from the edges table.
    const { data: edgeRow, error: edgeError } = await supabase
      .from("edges")
      .select("id")
      .eq("microgrid_id", microgridId)
      .eq("openems_edge_id", discoveredEdgeId)
      .maybeSingle();

    if (edgeError || !edgeRow) {
      setError(
        `Edge "${discoveredEdgeId}" not found for this microgrid. Register the edge first.`
      );
      setAddingDevice(null);
      return;
    }

    const { error: insertError } = await supabase.from("devices").insert({
      edge_id: edgeRow.id,
      name: namingValue.trim(),
      device_type: "consumption_meter",
      openems_component_id: device.componentId,
      config: {},
    });

    if (insertError) {
      setError(insertError.message);
      setAddingDevice(null);
      return;
    }

    // Optimistically mark as added so UI updates immediately (no race with router.refresh)
    setAddedKeys((prev) => new Set([...prev, device.componentId]));
    setAddingDevice(null);
    setNamingDeviceId(null);
    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {/* Delete Device ConfirmDialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete device?"
        description={deleteDescription}
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={handleDelete}
      />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Devices</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={handleDiscover}
            className="rounded-md bg-success px-3 py-1.5 text-sm text-success-foreground hover:opacity-90"
          >
            Discover Devices
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {error}
        </div>
      )}

      {showDiscovery && (
        <div className="mb-4 rounded-md border border-border bg-muted p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">
              Discovered Devices
            </h3>
            <button
              onClick={() => setShowDiscovery(false)}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>

          {discoveryLoading && (
            <p className="text-sm text-muted-foreground">
              Scanning OpenEMS for devices...
            </p>
          )}

          {discoveryError && (
            <div className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
              {discoveryError}
            </div>
          )}

          {!discoveryLoading &&
            !discoveryError &&
            discoveryResults.length === 0 && (
              <p className="text-sm text-muted-foreground">No edges found.</p>
            )}

          {!discoveryLoading &&
            !discoveryError &&
            discoveryResults.map((edge) => (
              <div key={edge.edgeId} className="mb-3 last:mb-0">
                <div className="mb-2 flex items-center gap-2">
                  <span
                    className={`inline-block h-2.5 w-2.5 rounded-full ${
                      edge.online ? "bg-success" : "bg-destructive"
                    }`}
                    title={edge.online ? "Online" : "Offline"}
                  />
                  <span className="text-sm font-medium text-foreground">
                    {edge.edgeId}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {edge.online ? "Online" : "Offline"}
                  </span>
                </div>

                {edge.devices.length === 0 ? (
                  <p className="ml-5 text-sm text-muted-foreground">
                    No devices found on this edge.
                  </p>
                ) : (
                  <div className="ml-5 space-y-2">
                    {edge.devices.map((device) => {
                      const alreadyAdded = existingKeys.has(device.componentId);
                      const typeInfo = DEVICE_TYPE_INFO[device.deviceType];

                      return (
                        <div
                          key={device.componentId}
                          className={`rounded-md border px-3 py-2 ${
                            alreadyAdded
                              ? "border-border bg-muted"
                              : "border-border bg-card"
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <div>
                                <p
                                  className={`text-sm font-medium ${
                                    alreadyAdded
                                      ? "text-muted-foreground"
                                      : "text-foreground"
                                  }`}
                                >
                                  {device.alias}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {device.componentId}
                                </p>
                              </div>
                              {alreadyAdded ? (
                                <StatusChip kind="meterType" status={device.deviceType} state="disabled" />
                              ) : (
                                <StatusChip kind="meterType" status={device.deviceType} />
                              )}
                            </div>

                            {alreadyAdded ? (
                              <span className="text-xs italic text-muted-foreground">
                                Already added
                              </span>
                            ) : namingDeviceId === device.componentId ? (
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={namingValue}
                                  onChange={(e) => setNamingValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter")
                                      handleAddDiscovered(edge.edgeId, device);
                                    if (e.key === "Escape")
                                      setNamingDeviceId(null);
                                  }}
                                  className="rounded-md border border-border px-2 py-1 text-sm"
                                  autoFocus
                                  placeholder="Enter device name"
                                />
                                <button
                                  onClick={() =>
                                    handleAddDiscovered(edge.edgeId, device)
                                  }
                                  disabled={
                                    !namingValue.trim() ||
                                    addingDevice === device.componentId
                                  }
                                  className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                >
                                  {addingDevice === device.componentId
                                    ? "Saving..."
                                    : "Save"}
                                </button>
                                <button
                                  onClick={() => setNamingDeviceId(null)}
                                  className="rounded-md border border-border px-3 py-1 text-sm text-foreground hover:bg-muted"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  setNamingDeviceId(device.componentId);
                                  setNamingValue(
                                    device.alias || device.componentId
                                  );
                                }}
                                className="rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground hover:opacity-90"
                              >
                                Add
                              </button>
                            )}
                          </div>
                          {typeInfo && !alreadyAdded && (
                            <div className="mt-1.5 ml-0 text-xs text-muted-foreground">
                              <p>{typeInfo.shortDesc}</p>
                              <p className="mt-0.5 italic text-muted-foreground">
                                {typeInfo.billingHint}
                              </p>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ))}
        </div>
      )}

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No devices configured. Use &quot;Discover Devices&quot; to find devices from OpenEMS.
        </p>
      ) : (
        <div className="space-y-2">
          {devices.map((device) => {
            const typeInfo = device.device_type
              ? DEVICE_TYPE_INFO[device.device_type.toUpperCase()]
              : null;
            return (
              <div
                key={device.id}
                className="flex items-center justify-between rounded-md border border-border bg-muted px-4 py-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground">{device.name}</p>
                    {device.device_type && (
                      <StatusChip kind="meterType" status={device.device_type.toUpperCase()} />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {device.openems_component_id ?? "—"}
                  </p>
                  {typeInfo && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {typeInfo.shortDesc}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => openDeleteDialog(device)}
                  className="rounded-md px-2 py-1 text-sm text-destructive hover:bg-destructive-muted"
                >
                  Delete
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
