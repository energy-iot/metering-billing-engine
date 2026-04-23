"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Device, Household } from "@/lib/types/domain";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function HouseholdTable({
  microgridId,
  households,
  devices,
  primaryDeviceAssignments,
}: {
  microgridId: string;
  households: Household[];
  devices: Device[];
  /** Map of household_id → device_id for primary_consumption_meter rows */
  primaryDeviceAssignments: Record<string, string>;
}) {
  const router = useRouter();
  const supabase = createClient();

  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Add form state
  const [newName, setNewName] = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [addSaving, setAddSaving] = useState(false);

  // Edit form state
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editSaving, setEditSaving] = useState(false);

  // Delete dialog state
  const [householdToDelete, setHouseholdToDelete] = useState<Household | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Optimistic device assignment overlay (household_id → device_id)
  const [localAssignments, setLocalAssignments] = useState<Record<string, string>>(
    primaryDeviceAssignments
  );

  function getDeviceName(deviceId: string | undefined): string {
    if (!deviceId) return "Unassigned";
    const device = devices.find((d) => d.id === deviceId);
    return device?.name ?? "Unknown device";
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!newName.trim()) {
      setError("Name is required");
      return;
    }

    setAddSaving(true);

    const { error: insertError } = await supabase.from("households").insert({
      microgrid_id: microgridId,
      display_name: newName.trim(),
      primary_phone: newPhone.trim() || null,
      primary_email: newEmail.trim() || null,
    });

    if (insertError) {
      setError(insertError.message);
      setAddSaving(false);
      return;
    }

    setNewName("");
    setNewPhone("");
    setNewEmail("");
    setShowAddForm(false);
    setAddSaving(false);
    router.refresh();
  }

  function startEdit(household: Household) {
    setEditingId(household.id);
    setEditName(household.display_name);
    setEditPhone(household.primary_phone ?? "");
    setEditEmail(household.primary_email ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function handleEditSave(householdId: string) {
    setError(null);

    if (!editName.trim()) {
      setError("Name is required");
      return;
    }

    setEditSaving(true);

    const { error: updateError } = await supabase
      .from("households")
      .update({
        display_name: editName.trim(),
        primary_phone: editPhone.trim() || null,
        primary_email: editEmail.trim() || null,
      })
      .eq("id", householdId);

    if (updateError) {
      setError(updateError.message);
      setEditSaving(false);
      return;
    }

    setEditingId(null);
    setEditSaving(false);
    router.refresh();
  }

  function openDeleteDialog(household: Household) {
    setHouseholdToDelete(household);
    setDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!householdToDelete) return;
    const { error: deleteError } = await supabase
      .from("households")
      .delete()
      .eq("id", householdToDelete.id);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    router.refresh();
  }

  /**
   * Assign a primary-consumption-meter device to a household via the
   * household_devices join table (delete + insert pattern).
   *
   * The partial unique index (household_one_primary_consumption_meter) ensures
   * at most one primary_consumption_meter per household. We delete any existing
   * row for this household+role pair, then insert the new assignment.
   */
  async function handleDeviceChange(householdId: string, deviceId: string) {
    setError(null);

    // Optimistic update
    setLocalAssignments((prev) => {
      const next = { ...prev };
      if (deviceId) {
        next[householdId] = deviceId;
      } else {
        delete next[householdId];
      }
      return next;
    });

    // Remove existing primary_consumption_meter row for this household
    const { error: deleteError } = await supabase
      .from("household_devices")
      .delete()
      .eq("household_id", householdId)
      .eq("role", "primary_consumption_meter");

    if (deleteError) {
      setError(deleteError.message);
      return;
    }

    if (deviceId) {
      // Insert new assignment
      const { error: insertError } = await supabase
        .from("household_devices")
        .insert({
          household_id: householdId,
          device_id: deviceId,
          role: "primary_consumption_meter",
        });

      if (insertError) {
        setError(insertError.message);
        return;
      }
    }

    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {/* Delete Household ConfirmDialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete household?"
        description={
          householdToDelete
            ? `Are you sure you want to delete "${householdToDelete.display_name}"?`
            : undefined
        }
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={handleDelete}
      />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Households</h2>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          {showAddForm ? "Cancel" : "Add Household"}
        </button>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg">
          {error}
        </div>
      )}

      {showAddForm && (
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
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              required
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:outline-none"
              placeholder="Household name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">
              Phone
            </label>
            <input
              type="text"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:outline-none"
              placeholder="Optional"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground">
              Email
            </label>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              className="mt-1 block w-full rounded-md border border-border px-3 py-2 text-foreground shadow-sm focus:outline-none"
              placeholder="Optional"
            />
          </div>
          <button
            type="submit"
            disabled={addSaving}
            className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {addSaving ? "Adding..." : "Add Household"}
          </button>
        </form>
      )}

      {households.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No households yet. Add a household to get started.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="pb-2 pr-4 font-medium text-muted-foreground">Name</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground">Phone</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground">Email</th>
                <th className="pb-2 pr-4 font-medium text-muted-foreground">
                  Billing Device
                </th>
                <th className="pb-2 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {households.map((household) => (
                <tr key={household.id} className="border-b border-border">
                  {editingId === household.id ? (
                    <>
                      <td className="py-3 pr-4">
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          required
                          className="w-full rounded-md border border-border px-2 py-1 text-foreground focus:outline-none"
                        />
                      </td>
                      <td className="py-3 pr-4">
                        <input
                          type="text"
                          value={editPhone}
                          onChange={(e) => setEditPhone(e.target.value)}
                          className="w-full rounded-md border border-border px-2 py-1 text-foreground focus:outline-none"
                        />
                      </td>
                      <td className="py-3 pr-4">
                        <input
                          type="email"
                          value={editEmail}
                          onChange={(e) => setEditEmail(e.target.value)}
                          className="w-full rounded-md border border-border px-2 py-1 text-foreground focus:outline-none"
                        />
                      </td>
                      <td className="py-3 pr-4">
                        <span className="text-muted-foreground">
                          {getDeviceName(localAssignments[household.id])}
                        </span>
                      </td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleEditSave(household.id)}
                            disabled={editSaving}
                            className="rounded-md px-2 py-1 text-sm text-primary hover:bg-accent disabled:opacity-50"
                          >
                            {editSaving ? "Saving..." : "Save"}
                          </button>
                          <button
                            onClick={cancelEdit}
                            className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
                          >
                            Cancel
                          </button>
                        </div>
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="py-3 pr-4 text-foreground">
                        {household.display_name}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {household.primary_phone ?? "-"}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {household.primary_email ?? "-"}
                      </td>
                      <td className="py-3 pr-4">
                        <div>
                          <select
                            value={localAssignments[household.id] ?? ""}
                            onChange={(e) =>
                              handleDeviceChange(household.id, e.target.value)
                            }
                            className="rounded-md border border-border px-2 py-1 text-sm text-foreground focus:outline-none"
                          >
                            <option value="">Unassigned</option>
                            {devices.map((device) => (
                              <option key={device.id} value={device.id}>
                                [{device.device_type}] {device.name}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Assign a consumption_meter device to bill this household.
                          </p>
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <Link
                            href={`/microgrids/${microgridId}/setup/households/${household.id}`}
                            className="rounded-md px-2 py-1 text-sm text-primary hover:bg-accent"
                          >
                            View
                          </Link>
                          <button
                            onClick={() => startEdit(household)}
                            className="rounded-md px-2 py-1 text-sm text-primary hover:bg-accent"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => openDeleteDialog(household)}
                            className="rounded-md px-2 py-1 text-sm text-destructive hover:bg-destructive-muted"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
