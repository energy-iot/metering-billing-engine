"use client";

/**
 * DiscoverMeterInline — single-pick consumption-meter discovery for the
 * Add-Household wizard's Step 3 (#200).
 *
 * Distinct from `<DiscoverDevices>` (the multi-pick edge-detail surface):
 *   - single-pick RadioGroup (one meter at a time)
 *   - filters discovery results to consumption_meter only
 *   - persists via POST /api/devices, then hands the saved device back to
 *     the wizard via `onDevicePersisted` so the parent can append it to
 *     `availableMeters` and auto-select it
 *   - errors are owned + rendered inline (no `onError` callback)
 *   - both fetches are guarded by a single AbortController so that an
 *     in-flight request doesn't leak results into a re-mounted instance
 *     (the wizard re-mounts on `state.no_meter` toggle via `key={…}`)
 *
 * Component contract (per ticket #200 Dev Notes):
 *   {
 *     edges: { id, name, openems_edge_id }[];
 *     edgeIdsWithoutConsumptionMeter: string[];
 *     microgridId: string;
 *     onDevicePersisted: (device: AvailableMeter) => void;
 *   }
 */

import * as React from "react";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { DiscoveredDevice, EdgeDiscoveryResponse } from "@/lib/openems/types";
import type { AvailableMeter } from "@/components/forms/HouseholdWizard";

export type DiscoverMeterInlineEdge = {
  id: string;
  name: string;
  openems_edge_id: string;
};

type Props = {
  edges: DiscoverMeterInlineEdge[];
  edgeIdsWithoutConsumptionMeter: string[];
  /** Reserved for future per-microgrid scoping; not used in current contract. */
  microgridId: string;
  /** Called after POST /api/devices succeeds; parent appends + auto-selects. */
  onDevicePersisted: (device: AvailableMeter) => void;
};

type Phase = "idle" | "discovering" | "ready" | "saving";

/**
 * Sort edges by (name, id) ascending — name first, id as a deterministic
 * tie-break for collidable names.
 */
function sortEdges(edges: DiscoverMeterInlineEdge[]): DiscoverMeterInlineEdge[] {
  return [...edges].sort((a, b) => {
    const n = a.name.localeCompare(b.name);
    return n !== 0 ? n : a.id.localeCompare(b.id);
  });
}

/**
 * Default-edge selector. Pre-selects the first edge in
 * `edgeIdsWithoutConsumptionMeter` sorted by (name, id) ascending; falls
 * back to the alphabetically first edge by (name, id) if every edge already
 * has at least one consumption_meter.
 */
function pickDefaultEdgeId(
  sortedEdges: DiscoverMeterInlineEdge[],
  edgeIdsWithoutConsumptionMeter: string[]
): string | null {
  if (sortedEdges.length === 0) return null;
  const withoutSet = new Set(edgeIdsWithoutConsumptionMeter);
  const firstWithout = sortedEdges.find((e) => withoutSet.has(e.id));
  return firstWithout?.id ?? sortedEdges[0].id;
}

export function DiscoverMeterInline({
  edges,
  edgeIdsWithoutConsumptionMeter,
  onDevicePersisted,
}: Props) {
  const sortedEdges = React.useMemo(() => sortEdges(edges), [edges]);

  const [pickedEdgeId, setPickedEdgeId] = React.useState<string>(
    () => pickDefaultEdgeId(sortedEdges, edgeIdsWithoutConsumptionMeter) ?? ""
  );
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [discovered, setDiscovered] = React.useState<DiscoveredDevice[]>([]);
  const [edgeOnline, setEdgeOnline] = React.useState<boolean>(true);
  const [pickedComponentId, setPickedComponentId] = React.useState<string>("");
  const [editedName, setEditedName] = React.useState<string>("");
  const [discoverError, setDiscoverError] = React.useState<string | null>(null);
  const [saveError, setSaveError] = React.useState<string | null>(null);

  // One AbortController guards both GET /discover-devices and POST /api/devices.
  // Cleanup aborts on unmount; the wizard re-mounts this component via
  // `key={state.no_meter}` whenever the user toggles the manual-billing
  // checkbox, so the unmount path is the canonical "cancel pending fetches"
  // signal.
  const abortRef = React.useRef<AbortController | null>(null);
  React.useEffect(() => {
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    return () => {
      ctrl.abort();
      abortRef.current = null;
    };
  }, []);

  const pickedEdge = sortedEdges.find((e) => e.id === pickedEdgeId) ?? null;

  // Filter discovery results to consumption_meter not yet linked.
  // The `openemsChannelAddress !== null` check is dropped per ticket #200:
  // channelAddressFor() always returns non-null for consumption_meter, so
  // the predicate is redundant.
  const candidates = React.useMemo(
    () =>
      discovered.filter(
        (d) => d.suggestedDeviceType === "consumption_meter" && d.alreadyAdded !== true
      ),
    [discovered]
  );

  const handleDiscover = React.useCallback(async () => {
    if (!pickedEdge) return;
    setPhase("discovering");
    setDiscoverError(null);
    setSaveError(null);
    setDiscovered([]);
    setPickedComponentId("");
    setEditedName("");
    setEdgeOnline(true);

    try {
      const res = await fetch(
        `/api/edges/${encodeURIComponent(pickedEdge.id)}/discover-devices`,
        { signal: abortRef.current?.signal }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setDiscoverError(
          body.error ?? `Discovery failed (HTTP ${res.status}).`
        );
        setPhase("idle");
        return;
      }
      const data = (await res.json()) as EdgeDiscoveryResponse;
      setEdgeOnline(data.online);
      setDiscovered(data.devices ?? []);
      setPhase("ready");
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setDiscoverError(
        "Could not reach the server. Check your network connection."
      );
      setPhase("idle");
    }
  }, [pickedEdge]);

  const handlePick = React.useCallback(
    (componentId: string) => {
      setPickedComponentId(componentId);
      const candidate = candidates.find((d) => d.componentId === componentId);
      if (candidate) {
        setEditedName(candidate.alias || candidate.componentId);
      }
      setSaveError(null);
    },
    [candidates]
  );

  const handleSave = React.useCallback(async () => {
    if (!pickedEdge) return;
    const candidate = candidates.find((d) => d.componentId === pickedComponentId);
    if (!candidate) return;
    setSaveError(null);
    setPhase("saving");

    try {
      const res = await fetch("/api/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          edgeId: pickedEdge.id,
          devices: [
            {
              componentId: candidate.componentId,
              factoryId: candidate.factoryId,
              deviceType: "consumption_meter",
              name: editedName.trim() || candidate.alias || candidate.componentId,
            },
          ],
        }),
        signal: abortRef.current?.signal,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setSaveError(
          body.error ??
            `Could not save the device (HTTP ${res.status}). Your selection is preserved — please retry.`
        );
        setPhase("ready");
        return;
      }

      const data = (await res.json()) as {
        saved: Array<{
          id: string;
          name: string;
          device_type: string;
          openems_component_id: string | null;
        }>;
      };
      const saved = data.saved?.[0];
      if (!saved) {
        setSaveError("Server did not return the saved device. Please retry.");
        setPhase("ready");
        return;
      }

      // Construct the AvailableMeter from the picked-edge object in scope —
      // POST /api/devices does not return edge_id / edge_name. Freshly-saved
      // devices are never linked, so linked_household_name is null.
      const newMeter: AvailableMeter = {
        id: saved.id,
        name: saved.name,
        device_type: saved.device_type as AvailableMeter["device_type"],
        edge_id: pickedEdge.id,
        edge_name: pickedEdge.name,
        linked_household_name: null,
      };

      onDevicePersisted(newMeter);
      // Reset the inline pick UI so re-discovery starts clean. Phase goes
      // back to 'ready' rather than 'idle' because the discovery list is
      // still relevant; the saved component will appear `alreadyAdded:true`
      // on the next discover.
      setPickedComponentId("");
      setEditedName("");
      setPhase("ready");
    } catch (err) {
      if ((err as { name?: string } | undefined)?.name === "AbortError") return;
      setSaveError(
        "Network error while saving. Your selection is preserved — please retry."
      );
      setPhase("ready");
    }
  }, [pickedEdge, candidates, pickedComponentId, editedName, onDevicePersisted]);

  if (sortedEdges.length === 0) {
    return null;
  }

  const isDiscovering = phase === "discovering";
  const isSaving = phase === "saving";
  const showResults = phase === "ready" || phase === "saving";

  return (
    <section
      aria-label="Discover meters on an edge"
      className="space-y-3 rounded-md border border-border bg-card p-3"
    >
      <header className="flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">
          Discover meters on an edge
        </h4>
      </header>
      <p className="text-xs text-muted-foreground">
        Scan an edge for new consumption meters and link one directly to this
        household — no need to leave the wizard.
      </p>

      {/* Edge picker. Collapses to a static label when there's exactly one. */}
      {sortedEdges.length === 1 ? (
        <div className="text-sm text-foreground">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Edge:
          </span>{" "}
          {sortedEdges[0].name}
        </div>
      ) : (
        <div>
          <label
            htmlFor="dmi-edge-select"
            className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            Edge
          </label>
          <Select
            value={pickedEdgeId}
            onValueChange={(v) => {
              setPickedEdgeId(v);
              setDiscovered([]);
              setPickedComponentId("");
              setEditedName("");
              setDiscoverError(null);
              setSaveError(null);
              setPhase("idle");
            }}
          >
            <SelectTrigger id="dmi-edge-select">
              <SelectValue placeholder="Pick an edge" />
            </SelectTrigger>
            <SelectContent>
              {sortedEdges.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleDiscover}
          disabled={!pickedEdge || isDiscovering || isSaving}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDiscovering ? "Scanning…" : "Discover meters"}
        </button>
      </div>

      {discoverError && (
        <div className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {discoverError}
          <button
            type="button"
            onClick={handleDiscover}
            className="ml-2 underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {showResults && !edgeOnline && (
        <div className="rounded-md bg-warning-muted p-3 text-sm text-warning-fg">
          Edge is offline — retry when it reconnects.
        </div>
      )}

      {showResults && edgeOnline && candidates.length === 0 && (
        <p className="rounded-md border border-border bg-muted p-3 text-sm text-muted-foreground">
          No new consumption meters on this edge. Make sure the edge is online
          and has components configured.
        </p>
      )}

      {showResults && candidates.length > 0 && (
        <div className="space-y-3">
          <RadioGroup
            value={pickedComponentId}
            onValueChange={handlePick}
            aria-label="Discovered consumption meters"
            className="gap-2"
          >
            {candidates.map((c) => {
              const id = `dmi-cand-${c.componentId}`;
              return (
                <label
                  key={c.componentId}
                  htmlFor={id}
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 hover:bg-muted"
                >
                  <RadioGroupItem id={id} value={c.componentId} className="mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">
                      {c.alias || c.componentId}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {c.componentId}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {c.factoryId}
                    </div>
                  </div>
                </label>
              );
            })}
          </RadioGroup>

          {pickedComponentId && (
            <div className="space-y-2 rounded-md border border-border bg-muted p-3">
              <div>
                <label
                  htmlFor="dmi-name"
                  className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Device name
                </label>
                <Input
                  id="dmi-name"
                  type="text"
                  value={editedName}
                  onChange={(e) => setEditedName(e.target.value)}
                  placeholder="Device name"
                />
              </div>
              {saveError && (
                <div className="rounded-md bg-destructive-muted p-2 text-xs text-destructive-fg">
                  {saveError}
                </div>
              )}
              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={isSaving || !editedName.trim()}
                  className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isSaving ? "Saving…" : "Save & select"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
