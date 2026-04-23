"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Meter, Tenant } from "@/lib/types/database";
import type {
  DiscoveredMeter,
  EdgeDiscoveryResult,
  MeterType,
  OpenEmsDataSourceConfig,
} from "@/lib/openems/types";
import { METER_TYPE_INFO } from "@/lib/openems/meter-descriptions";
import { StatusChip } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function MeterManager({
  microgridId,
  meters,
  tenants,
}: {
  microgridId: string;
  meters: Meter[];
  tenants: Tenant[];
}) {
  const router = useRouter();
  const supabase = createClient();

  const [showForm, setShowForm] = useState(false);
  const [showDiscovery, setShowDiscovery] = useState(false);
  const [name, setName] = useState("");
  const [edgeId, setEdgeId] = useState("");
  const [channelAddress, setChannelAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Discovery state
  const [discoveryResults, setDiscoveryResults] = useState<
    EdgeDiscoveryResult[]
  >([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [addingMeter, setAddingMeter] = useState<string | null>(null);
  // Optimistic tracking of meters added during this session (before router.refresh() completes)
  const [addedKeys, setAddedKeys] = useState<Set<string>>(new Set());

  // Friendly name input state
  const [namingMeterId, setNamingMeterId] = useState<string | null>(null);
  const [namingValue, setNamingValue] = useState("");

  // Refresh types state
  const [refreshing, setRefreshing] = useState(false);
  const [refreshResult, setRefreshResult] = useState<string | null>(null);

  // Delete dialog state
  const [meterToDelete, setMeterToDelete] = useState<Meter | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Build set of already-added meter keys for dedup (prop-based + optimistic)
  const existingKeys = new Set([
    ...meters
      .filter((m) => m.data_source_type === "openems")
      .map((m) => {
        const config = m.data_source_config as OpenEmsDataSourceConfig;
        return `${config.edgeId}:${config.channelAddress.split("/")[0]}`;
      }),
    ...addedKeys,
  ]);

  // Derive edge IDs from existing meters, defaulting to "edge0" if none configured
  function getDiscoverEdgeIds(): string {
    const edgeIds = new Set(
      meters
        .filter((m) => m.data_source_type === "openems")
        .map((m) => (m.data_source_config as OpenEmsDataSourceConfig).edgeId)
    );
    return edgeIds.size > 0 ? Array.from(edgeIds).join(",") : "edge0";
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!name.trim() || !edgeId.trim() || !channelAddress.trim()) {
      setError("All fields are required");
      return;
    }

    setSaving(true);

    const { error: insertError } = await supabase.from("meters").insert({
      microgrid_id: microgridId,
      name: name.trim(),
      data_source_type: "openems",
      data_source_config: {
        edgeId: edgeId.trim(),
        channelAddress: channelAddress.trim(),
      },
    });

    if (insertError) {
      setError(insertError.message);
      setSaving(false);
      return;
    }

    setName("");
    setEdgeId("");
    setChannelAddress("");
    setShowForm(false);
    setSaving(false);
    router.refresh();
  }

  function openDeleteDialog(meter: Meter) {
    setMeterToDelete(meter);
    setDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!meterToDelete) return;
    const { error: deleteError } = await supabase
      .from("meters")
      .delete()
      .eq("id", meterToDelete.id);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    router.refresh();
  }

  // Build delete dialog description
  const deleteDescription = meterToDelete
    ? (() => {
        const assignedTenants = tenants.filter((t) => t.meter_id === meterToDelete.id);
        const tenantNames = assignedTenants.map((t) => t.name).join(", ");
        return assignedTenants.length > 0
          ? `This meter is assigned to: ${tenantNames}. Deleting it will unassign their meter.`
          : `Delete "${meterToDelete.name}"?`;
      })()
    : undefined;

  async function handleDiscover() {
    setShowDiscovery(true);
    setShowForm(false);
    setDiscoveryError(null);
    setDiscoveryLoading(true);

    try {
      const res = await fetch(`/api/openems/discover?edgeIds=${encodeURIComponent(getDiscoverEdgeIds())}`);
      const data = await res.json();

      if (!res.ok) {
        setDiscoveryError(data.error || "Failed to discover meters");
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
    meter: DiscoveredMeter
  ) {
    if (!namingValue.trim()) return;

    setAddingMeter(meter.componentId);
    setError(null);

    const { error: insertError } = await supabase.from("meters").insert({
      microgrid_id: microgridId,
      name: namingValue.trim(),
      data_source_type: "openems",
      data_source_config: {
        edgeId: discoveredEdgeId,
        channelAddress: meter.channelAddress,
      },
      meter_type: meter.meterType !== "UNKNOWN" ? meter.meterType : null,
    });

    if (insertError) {
      setError(insertError.message);
      setAddingMeter(null);
      return;
    }

    // Optimistically mark as added so UI updates immediately (no race with router.refresh)
    setAddedKeys((prev) => new Set([...prev, `${discoveredEdgeId}:${meter.componentId}`]));
    setAddingMeter(null);
    setNamingMeterId(null);
    router.refresh();
  }

  async function handleRefreshTypes() {
    setRefreshing(true);
    setRefreshResult(null);
    setError(null);

    try {
      const edgeIds = getDiscoverEdgeIds();
      const res = await fetch(
        `/api/openems/discover?edgeIds=${encodeURIComponent(edgeIds)}`
      );
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Failed to fetch meter types");
        return;
      }

      const edges: EdgeDiscoveryResult[] = data.edges ?? [];

      // Build a lookup: channelAddress → meterType
      const typeByChannel = new Map<string, MeterType>();
      for (const edge of edges) {
        for (const dm of edge.meters) {
          typeByChannel.set(
            `${edge.edgeId}:${dm.channelAddress}`,
            dm.meterType
          );
        }
      }

      // Update meters that have meter_type: null
      let updated = 0;
      for (const meter of meters) {
        if (meter.meter_type !== null) continue;
        if (meter.data_source_type !== "openems") continue;

        const config = meter.data_source_config as OpenEmsDataSourceConfig;
        const key = `${config.edgeId}:${config.channelAddress}`;
        const discoveredType = typeByChannel.get(key);

        if (!discoveredType) continue;

        const newType = discoveredType !== "UNKNOWN" ? discoveredType : null;
        if (newType === null) continue;

        const { error: updateError } = await supabase
          .from("meters")
          .update({ meter_type: newType })
          .eq("id", meter.id);

        if (!updateError) updated++;
      }

      setRefreshResult(
        updated > 0 ? `Updated ${updated} meter(s)` : "All meters already have types"
      );
      if (updated > 0) router.refresh();

      // Clear message after 4 seconds
      setTimeout(() => setRefreshResult(null), 4000);
    } catch {
      setError("Could not reach the server. Check your network connection.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {/* Delete Meter ConfirmDialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete meter?"
        description={deleteDescription}
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={handleDelete}
      />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Meters</h2>
        <div className="flex items-center gap-2">
          {refreshResult && (
            <span className="text-xs text-success-fg">{refreshResult}</span>
          )}
          <button
            onClick={handleRefreshTypes}
            disabled={refreshing}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
          >
            {refreshing ? "Refreshing..." : "Refresh Types"}
          </button>
          <button
            onClick={handleDiscover}
            className="rounded-md bg-success px-3 py-1.5 text-sm text-success-foreground hover:opacity-90"
          >
            Discover Meters
          </button>
          <button
            onClick={() => {
              setShowForm(!showForm);
              setShowDiscovery(false);
            }}
            className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
          >
            {showForm ? "Cancel" : "Add Meter"}
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
              Discovered Meters
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
              Scanning OpenEMS for meters...
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

                {edge.meters.length === 0 ? (
                  <p className="ml-5 text-sm text-muted-foreground">
                    No meters found on this edge.
                  </p>
                ) : (
                  <div className="ml-5 space-y-2">
                    {edge.meters.map((meter) => {
                      const alreadyAdded = existingKeys.has(
                        `${edge.edgeId}:${meter.componentId}`
                      );

                      const typeInfo = METER_TYPE_INFO[meter.meterType];

                      return (
                        <div
                          key={meter.componentId}
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
                                  {meter.alias}
                                </p>
                                <p
                                  className={`text-xs ${
                                    alreadyAdded
                                      ? "text-muted-foreground"
                                      : "text-muted-foreground"
                                  }`}
                                >
                                  {meter.componentId}
                                </p>
                              </div>
                              {alreadyAdded ? (
                                <StatusChip kind="meterType" status={meter.meterType} state="disabled" />
                              ) : (
                                <StatusChip kind="meterType" status={meter.meterType} />
                              )}
                            </div>

                            {alreadyAdded ? (
                              <span className="text-xs italic text-muted-foreground">
                                Already added
                              </span>
                            ) : namingMeterId === meter.componentId ? (
                              <div className="flex items-center gap-2">
                                <input
                                  type="text"
                                  value={namingValue}
                                  onChange={(e) => setNamingValue(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") handleAddDiscovered(edge.edgeId, meter);
                                    if (e.key === "Escape") setNamingMeterId(null);
                                  }}
                                  className="rounded-md border border-border px-2 py-1 text-sm"
                                  autoFocus
                                  placeholder="Enter meter name"
                                />
                                <button
                                  onClick={() => handleAddDiscovered(edge.edgeId, meter)}
                                  disabled={!namingValue.trim() || addingMeter === meter.componentId}
                                  className="rounded-md bg-primary px-3 py-1 text-sm text-primary-foreground hover:opacity-90 disabled:opacity-50"
                                >
                                  {addingMeter === meter.componentId ? "Saving..." : "Save"}
                                </button>
                                <button
                                  onClick={() => setNamingMeterId(null)}
                                  className="rounded-md border border-border px-3 py-1 text-sm text-foreground hover:bg-muted"
                                >
                                  Cancel
                                </button>
                              </div>
                            ) : (
                              <button
                                onClick={() => {
                                  setNamingMeterId(meter.componentId);
                                  setNamingValue(meter.alias || meter.componentId);
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

      {showForm && (
        <form
          onSubmit={handleAdd}
          className="mb-4 space-y-3 rounded-md border border-border bg-muted p-4"
        >
          <div>
            <label className="block text-sm font-medium text-foreground">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:outline-none"
              placeholder="e.g. Unit 1 Meter"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">
              Data Source
            </label>
            <input
              type="text"
              value="openems"
              disabled
              className="mt-1 block w-full rounded-md border border-border bg-muted px-3 py-2 text-muted-foreground"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">
              Edge ID
            </label>
            <input
              type="text"
              value={edgeId}
              onChange={(e) => setEdgeId(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:outline-none"
              placeholder="e.g. edge0"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">
              Channel Address
            </label>
            <input
              type="text"
              value={channelAddress}
              onChange={(e) => setChannelAddress(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:outline-none"
              placeholder="e.g. meter0/ActiveConsumptionEnergy"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Adding..." : "Add Meter"}
          </button>
        </form>
      )}

      {meters.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No meters configured. Add a meter to start assigning tenants.
        </p>
      ) : (
        <div className="space-y-2">
          {meters.map((meter) => {
            const config = meter.data_source_config as OpenEmsDataSourceConfig;
            const typeInfo = meter.meter_type
              ? METER_TYPE_INFO[meter.meter_type]
              : null;
            return (
              <div
                key={meter.id}
                className="flex items-center justify-between rounded-md border border-border bg-muted px-4 py-3"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <p className="font-medium text-foreground">{meter.name}</p>
                    {meter.meter_type && (
                      <StatusChip kind="meterType" status={meter.meter_type} />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {config.edgeId} / {config.channelAddress}
                  </p>
                  {typeInfo && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {typeInfo.shortDesc}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => openDeleteDialog(meter)}
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
