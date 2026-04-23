"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Device, Household } from "@/lib/types/domain";
import { DEVICE_TYPE_INFO } from "@/lib/openems/device-descriptions";
import { StatusChip } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

/**
 * DeviceManager — lists and manages OpenEMS devices linked to this microgrid.
 *
 * Discovery (adding new devices) is handled by DiscoverDevices on the Edge
 * detail page. This component is intentionally listing/manage-only: delete
 * is the primary mutation exposed here.
 */
export function DeviceManager({
  devices,
  households,
}: {
  microgridId: string;
  devices: Device[];
  households: Household[];
}) {
  const router = useRouter();
  const supabase = createClient();

  // Delete dialog state
  const [deviceToDelete, setDeviceToDelete] = useState<Device | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

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
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No devices configured. Use the Edge detail page to discover and add
          devices from OpenEMS.
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
