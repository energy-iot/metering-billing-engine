"use client";

/**
 * DiscoverDevices — client component for the Discover devices flow (F #57).
 *
 * Rendered on the edge detail page (Setup > Edges > [edgeId]).
 * Responsible for:
 *   1. Triggering GET /api/openems/discover?edgeId=<openemsEdgeId>
 *   2. Rendering each discovered component with:
 *      - factoryId (small) + alias (pre-filled name input)
 *      - suggestedDeviceType chip (StatusChip kind="deviceType")
 *      - device_type dropdown (shadcn Select, overridable)
 *      - inline help card below dropdown (from DEVICE_TYPE_HELP)
 *      - alreadyAdded → disabled row + "Already added" chip
 *   3. POSTing selected rows to /api/devices (server-side transactional upsert)
 *
 * DeviceManager.tsx is NOT modified — this is a separate component that renders
 * alongside the existing device list on the edge detail page.
 */

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { StatusChip } from "@/components/ui/status-chip";
import { Chip } from "@/components/ui/chip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEVICE_TYPE_HELP } from "@/lib/device-type-help";
import type { DiscoveredDevice } from "@/lib/openems/types";
import type { DeviceType } from "@/lib/types/domain";

const DEVICE_TYPE_OPTIONS: DeviceType[] = [
  "consumption_meter",
  "grid_meter",
  "pv_meter",
  "battery",
  "inverter",
  "ev_charger",
  "other",
];

type RowState = {
  name: string;
  deviceType: DeviceType;
};

type Props = {
  /** DB UUID of the edge (from the edges table) */
  edgeDbId: string;
  /** OpenEMS edge ID string (e.g. "edge0") — used for the discover API call */
  openemsEdgeId: string;
};

export function DiscoverDevices({ edgeDbId, openemsEdgeId }: Props) {
  const router = useRouter();

  const [phase, setPhase] = useState<"idle" | "discovering" | "ready" | "saving">("idle");
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);

  // Per-row editable state (name + deviceType override)
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  // Which row's help card is open (keyed by componentId)
  const [openHelp, setOpenHelp] = useState<string | null>(null);

  const handleDiscover = useCallback(async () => {
    setPhase("discovering");
    setDiscoverError(null);
    setSaveError(null);
    setDevices([]);
    setRowState({});
    setOpenHelp(null);

    try {
      const res = await fetch(
        `/api/openems/discover?edgeId=${encodeURIComponent(openemsEdgeId)}`
      );
      const data = await res.json();

      if (!res.ok) {
        setDiscoverError(data.error ?? "Failed to discover devices");
        setPhase("idle");
        return;
      }

      const discovered: DiscoveredDevice[] = data.devices ?? [];
      setDevices(discovered);

      // Initialise editable row state from discovery results
      const initial: Record<string, RowState> = {};
      for (const d of discovered) {
        initial[d.componentId] = {
          name: d.alias || d.componentId,
          deviceType: d.suggestedDeviceType,
        };
      }
      setRowState(initial);
      setPhase("ready");
    } catch {
      setDiscoverError("Could not reach the server. Check your network connection.");
      setPhase("idle");
    }
  }, [openemsEdgeId]);

  const handleSave = useCallback(async () => {
    // Only save rows that are not already added and have a billable channel address.
    // Null-channel rows (battery, inverter, grid_meter, pv_meter) are excluded by default;
    // force-saving without a channel is deferred to a future ticket.
    const toSave = devices.filter((d) => !d.alreadyAdded && d.openemsChannelAddress !== null);
    if (toSave.length === 0) return;

    setSaveError(null);
    setPhase("saving");

    try {
      const payload = {
        edgeId: edgeDbId,
        devices: toSave.map((d) => {
          const row = rowState[d.componentId];
          return {
            componentId: d.componentId,
            factoryId: d.factoryId,
            openemsChannelAddress: d.openemsChannelAddress,
            deviceType: row?.deviceType ?? d.suggestedDeviceType,
            name: row?.name.trim() || d.alias || d.componentId,
          };
        }),
      };

      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        setSaveError(data.error ?? "Failed to save devices. Your selections have been preserved — please retry.");
        setPhase("ready");
        return;
      }

      // Success: refresh the page to show newly added devices
      router.refresh();
      setPhase("idle");
      setDevices([]);
      setRowState({});
    } catch {
      setSaveError("Network error while saving. Please retry.");
      setPhase("ready");
    }
  }, [devices, rowState, edgeDbId, router]);

  const updateRow = useCallback(
    (componentId: string, patch: Partial<RowState>) => {
      setRowState((prev) => ({
        ...prev,
        [componentId]: { ...prev[componentId], ...patch },
      }));
    },
    []
  );

  // Pending = not already added AND has a billable channel (null-channel rows are excluded from Save)
  const pendingCount = devices.filter((d) => !d.alreadyAdded && d.openemsChannelAddress !== null).length;
  // Derived flags so TypeScript doesn't narrow phase away inside JSX blocks
  const isSaving = phase === "saving";
  const isDiscovering = phase === "discovering";
  const showResults = phase === "ready" || phase === "saving";

  return (
    <div className="mt-6">
      {/* Header row */}
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-base font-semibold text-foreground">
          Discover devices
        </h3>
        <button
          onClick={handleDiscover}
          disabled={isDiscovering || isSaving}
          className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {isDiscovering ? "Scanning…" : "Discover devices"}
        </button>
      </div>

      {/* Discover error */}
      {discoverError && (
        <div className="mb-3 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {discoverError}
          <button
            onClick={handleDiscover}
            className="ml-2 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Save error — preserved user selections */}
      {saveError && (
        <div className="mb-3 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {saveError}
        </div>
      )}

      {/* Results */}
      {showResults && (
        <>
          {devices.length === 0 ? (
            <p className="rounded-md border border-border bg-muted p-4 text-sm text-muted-foreground">
              No new components found on this edge. (Make sure the edge is
              online and has components configured.)
            </p>
          ) : (
            <div className="space-y-3">
              {devices.map((device) => {
                const row = rowState[device.componentId];
                const selectedType = row?.deviceType ?? device.suggestedDeviceType;
                const helpEntry = DEVICE_TYPE_HELP[selectedType];
                const isHelpOpen = openHelp === device.componentId;

                if (device.alreadyAdded) {
                  return (
                    <div
                      key={device.componentId}
                      className="flex items-center justify-between rounded-md border border-border bg-muted px-4 py-3 opacity-60"
                    >
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-muted-foreground">
                            {device.alias || device.componentId}
                          </p>
                          <StatusChip
                            kind="deviceType"
                            status={device.suggestedDeviceType}
                            state="disabled"
                          />
                        </div>
                        <p className="font-mono text-xs text-muted-foreground">
                          {device.componentId}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {device.factoryId}
                        </p>
                      </div>
                      <Chip tone="neutral" state="disabled">
                        Already added
                      </Chip>
                    </div>
                  );
                }

                // Null-channel devices: no single auto-billing channel exists for this
                // device type. Render as muted row with explanatory help text. Excluded
                // from the Save payload (force-save is a future ticket).
                if (device.openemsChannelAddress === null) {
                  return (
                    <div
                      key={device.componentId}
                      className="rounded-md border border-border bg-muted px-4 py-3"
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="text-sm font-medium text-muted-foreground">
                              {device.alias || device.componentId}
                            </p>
                            <StatusChip
                              kind="deviceType"
                              status={device.suggestedDeviceType}
                              state="disabled"
                            />
                          </div>
                          <p className="font-mono text-xs text-muted-foreground">
                            {device.componentId}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {device.factoryId}
                          </p>
                        </div>
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground">
                        No auto-billing channel for this device type; device metadata saved without an auto-query channel.
                      </p>
                    </div>
                  );
                }

                return (
                  <div
                    key={device.componentId}
                    className="rounded-md border border-border bg-card px-4 py-3"
                  >
                    {/* Row header: alias + chip */}
                    <div className="mb-2 flex items-start justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">
                            {device.alias || device.componentId}
                          </span>
                          <StatusChip
                            kind="deviceType"
                            status={device.suggestedDeviceType}
                          />
                        </div>
                        <p className="font-mono text-xs text-muted-foreground">
                          {device.componentId}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {device.factoryId}
                        </p>
                      </div>
                    </div>

                    {/* Name input */}
                    <div className="mb-2">
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Device name
                      </label>
                      <input
                        type="text"
                        value={row?.name ?? ""}
                        onChange={(e) =>
                          updateRow(device.componentId, { name: e.target.value })
                        }
                        placeholder="Enter device name"
                        className="w-full rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                      />
                    </div>

                    {/* Device type dropdown */}
                    <div className="mb-2">
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">
                        Device type
                      </label>
                      <Select
                        value={selectedType}
                        onValueChange={(val) => {
                          updateRow(device.componentId, {
                            deviceType: val as DeviceType,
                          });
                          setOpenHelp(device.componentId);
                        }}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {DEVICE_TYPE_OPTIONS.map((dt) => (
                            <SelectItem key={dt} value={dt}>
                              {DEVICE_TYPE_HELP[dt].label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Inline help card (below dropdown, not a tooltip, not a side panel) */}
                    <div className="mt-1">
                      <button
                        type="button"
                        onClick={() =>
                          setOpenHelp(isHelpOpen ? null : device.componentId)
                        }
                        className="text-xs text-muted-foreground underline hover:text-foreground hover:no-underline"
                      >
                        {isHelpOpen ? "Hide help" : "What is this?"}
                      </button>
                      {isHelpOpen && helpEntry && (
                        <div className="mt-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
                          <p className="font-medium text-foreground">
                            {helpEntry.label}
                          </p>
                          <p className="mt-0.5">{helpEntry.description}</p>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}

              {/* Save bar */}
              {pendingCount > 0 && (
                <div className="flex items-center justify-end gap-3 pt-1">
                  <span className="text-sm text-muted-foreground">
                    {pendingCount} device{pendingCount !== 1 ? "s" : ""} to add
                  </span>
                  <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  >
                    {isSaving ? "Saving…" : "Save devices"}
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
