"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Meter, Tenant } from "@/lib/types/database";
import type { OpenEmsDataSourceConfig } from "@/lib/openems/types";

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
  const [name, setName] = useState("");
  const [edgeId, setEdgeId] = useState("");
  const [channelAddress, setChannelAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      data_source_config: { edgeId: edgeId.trim(), channelAddress: channelAddress.trim() },
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

  async function handleDelete(meter: Meter) {
    const assignedTenants = tenants.filter((t) => t.meter_id === meter.id);
    const message =
      assignedTenants.length > 0
        ? `This meter is assigned to ${assignedTenants.length} tenant(s). Deleting it will unassign them.\n\nAre you sure you want to delete "${meter.name}"?`
        : `Are you sure you want to delete "${meter.name}"?`;

    if (!confirm(message)) return;

    const { error: deleteError } = await supabase
      .from("meters")
      .delete()
      .eq("id", meter.id);

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    router.refresh();
  }

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Meters</h2>
        <button
          onClick={() => setShowForm(!showForm)}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700"
        >
          {showForm ? "Cancel" : "Add Meter"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {showForm && (
        <form
          onSubmit={handleAdd}
          className="mb-4 space-y-3 rounded-md border border-gray-200 bg-gray-50 p-4"
        >
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="e.g. Unit 1 Meter"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Data Source
            </label>
            <input
              type="text"
              value="openems"
              disabled
              className="mt-1 block w-full rounded-md border border-gray-200 bg-gray-100 px-3 py-2 text-gray-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Edge ID
            </label>
            <input
              type="text"
              value={edgeId}
              onChange={(e) => setEdgeId(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="e.g. edge0"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700">
              Channel Address
            </label>
            <input
              type="text"
              value={channelAddress}
              onChange={(e) => setChannelAddress(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="e.g. meter0/ActiveConsumptionEnergy"
            />
          </div>
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? "Adding..." : "Add Meter"}
          </button>
        </form>
      )}

      {meters.length === 0 ? (
        <p className="text-sm text-gray-500">
          No meters configured. Add a meter to start assigning tenants.
        </p>
      ) : (
        <div className="space-y-2">
          {meters.map((meter) => {
            const config = meter.data_source_config as OpenEmsDataSourceConfig;
            return (
              <div
                key={meter.id}
                className="flex items-center justify-between rounded-md border border-gray-100 bg-gray-50 px-4 py-3"
              >
                <div>
                  <p className="font-medium text-gray-900">{meter.name}</p>
                  <p className="text-sm text-gray-500">
                    {config.edgeId} / {config.channelAddress}
                  </p>
                </div>
                <button
                  onClick={() => handleDelete(meter)}
                  className="rounded-md px-2 py-1 text-sm text-red-600 hover:bg-red-50 hover:text-red-700"
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
