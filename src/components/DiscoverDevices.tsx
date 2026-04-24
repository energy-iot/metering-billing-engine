"use client";

/**
 * DiscoverDevices — client component for the Discover devices flow (F #57).
 *
 * Rendered on the edge detail page (Setup > Edges > [edgeId]).
 * Responsible for:
 *   1. Triggering GET /api/edges/<edgeDbId>/discover-devices
 *   2. Rendering each discovered component in a unified list with:
 *      - per-row checkbox (already-added rows: pre-checked + disabled)
 *      - factoryId (small) + alias (pre-filled name input) for selectable rows
 *      - suggestedDeviceType chip (StatusChip kind="deviceType")
 *      - device_type dropdown (shadcn Select, overridable) for selectable rows
 *      - inline help card below dropdown (from DEVICE_TYPE_HELP) for selectable rows
 *      - observability-only note for rows with openemsChannelAddress === null
 *      - alreadyAdded → disabled row + "Already added" chip
 *   3. POSTing selected rows to /api/devices (server-side transactional upsert)
 *      Selected rows with openemsChannelAddress: null are saved for observability
 *      (no billing channel) — previously these were silently excluded.
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

// openemsEdgeId is retained in the Props interface for future display use;
// the discover fetch now uses edgeDbId directly.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function DiscoverDevices({ edgeDbId, openemsEdgeId }: Props) {
  const router = useRouter();

  const [phase, setPhase] = useState<"idle" | "discovering" | "ready" | "saving">("idle");
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [devices, setDevices] = useState<DiscoveredDevice[]>([]);

  // Per-row editable state (name + deviceType override)
  const [rowState, setRowState] = useState<Record<string, RowState>>({});

  // Per-row selection state (keyed by componentId, true = selected)
  // Already-added rows are always excluded from this state (their checkbox is disabled).
  const [selected, setSelected] = useState<Record<string, boolean>>({});

  // Which row's help card is open (keyed by componentId)
  const [openHelp, setOpenHelp] = useState<string | null>(null);

  const handleDiscover = useCallback(async () => {
    setPhase("discovering");
    setDiscoverError(null);
    setSaveError(null);
    setDevices([]);
    setRowState({});
    setSelected({});
    setOpenHelp(null);

    try {
      const res = await fetch(
        `/api/edges/${encodeURIComponent(edgeDbId)}/discover-devices`
      );
      const data = await res.json();

      if (!res.ok) {
        setDiscoverError(data.error ?? "Failed to discover devices");
        setPhase("idle");
        return;
      }

      const discovered: DiscoveredDevice[] = data.devices ?? [];
      setDevices(discovered);

      // Initialise editable row state and selection state from discovery results
      const initial: Record<string, RowState> = {};
      const initialSelected: Record<string, boolean> = {};
      for (const d of discovered) {
        initial[d.componentId] = {
          name: d.alias || d.componentId,
          deviceType: d.suggestedDeviceType,
        };
        // Auto-select all new (non-already-added) rows by default
        if (!d.alreadyAdded) {
          initialSelected[d.componentId] = true;
        }
      }
      setRowState(initial);
      setSelected(initialSelected);
      setPhase("ready");
    } catch {
      setDiscoverError("Could not reach the server. Check your network connection.");
      setPhase("idle");
    }
  }, [edgeDbId]);

  const handleSave = useCallback(async () => {
    // Save all selected rows that are not already added (regardless of channel null-ness)
    const toSave = devices.filter((d) => !d.alreadyAdded && selected[d.componentId]);
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
            openemsChannelAddress: d.openemsChannelAddress, // may be null — server accepts
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
      setSelected({});
    } catch {
      setSaveError("Network error while saving. Please retry.");
      setPhase("ready");
    }
  }, [devices, rowState, selected, edgeDbId, router]);

  const updateRow = useCallback(
    (componentId: string, patch: Partial<RowState>) => {
      setRowState((prev) => ({
        ...prev,
        [componentId]: { ...prev[componentId], ...patch },
      }));
    },
    []
  );

  const toggleSelected = useCallback((componentId: string) => {
    setSelected((prev) => ({ ...prev, [componentId]: !prev[componentId] }));
  }, []);

  // Count = selected rows that are NOT already-added (regardless of channel null-ness)
  const pendingCount = devices.filter(
    (d) => !d.alreadyAdded && selected[d.componentId]
  ).length;

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
                const isAlreadyAdded = device.alreadyAdded === true;
                const isChecked = isAlreadyAdded || !!selected[device.componentId];
                const hasNullChannel = device.openemsChannelAddress === null;

                return (
                  <div
                    key={device.componentId}
                    className={[
                      "rounded-md border border-border px-4 py-3",
                      isAlreadyAdded ? "bg-muted opacity-60" : "bg-card",
                    ].join(" ")}
                  >
                    {/* Row header: checkbox + alias + chip */}
                    <div className="mb-2 flex items-start gap-3">
                      {/* Checkbox */}
                      <div className="mt-0.5 flex-shrink-0">
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={isAlreadyAdded}
                          aria-disabled={isAlreadyAdded ? "true" : undefined}
                          onChange={() => {
                            if (!isAlreadyAdded) toggleSelected(device.componentId);
                          }}
                          className="h-4 w-4 cursor-pointer rounded border-border accent-primary disabled:cursor-not-allowed"
                        />
                      </div>

                      {/* Device identity */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span
                            className={[
                              "text-sm font-medium",
                              isAlreadyAdded
                                ? "text-muted-foreground"
                                : "text-foreground",
                            ].join(" ")}
                          >
                            {device.alias || device.componentId}
                          </span>
                          <StatusChip
                            kind="deviceType"
                            status={device.suggestedDeviceType}
                            state={isAlreadyAdded ? "disabled" : undefined}
                          />
                          {isAlreadyAdded && (
                            <Chip tone="neutral" state="disabled">
                              Already added
                            </Chip>
                          )}
                        </div>
                        <p className="font-mono text-xs text-muted-foreground">
                          {device.componentId}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {device.factoryId}
                        </p>
                      </div>
                    </div>

                    {/* Selectable row controls (not shown for already-added) */}
                    {!isAlreadyAdded && (
                      <>
                        {/* Observability-only note for null-channel devices */}
                        {hasNullChannel && (
                          <p className="mb-2 text-xs text-muted-foreground">
                            No auto-billing channel for this device type — this device will be registered for observability but won&apos;t contribute to household billing.
                          </p>
                        )}

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
                      </>
                    )}
                  </div>
                );
              })}

              {/* Save bar */}
              <div className="flex items-center justify-end gap-3 pt-1">
                <span className="text-sm text-muted-foreground">
                  {pendingCount} device{pendingCount !== 1 ? "s" : ""} selected
                </span>
                <button
                  onClick={handleSave}
                  disabled={isSaving || pendingCount === 0}
                  className="rounded-md bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
                >
                  {isSaving ? "Adding…" : `Add ${pendingCount} device${pendingCount !== 1 ? "s" : ""}`}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
