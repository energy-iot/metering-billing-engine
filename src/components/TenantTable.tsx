"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import type { Meter, Tenant } from "@/lib/types/database";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function TenantTable({
  microgridId,
  tenants,
  meters,
}: {
  microgridId: string;
  tenants: Tenant[];
  meters: Meter[];
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
  const [tenantToDelete, setTenantToDelete] = useState<Tenant | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  // Compute which meters are shared (assigned to multiple tenants)
  const meterAssignmentCounts = new Map<string, number>();
  for (const tenant of tenants) {
    if (tenant.meter_id) {
      meterAssignmentCounts.set(
        tenant.meter_id,
        (meterAssignmentCounts.get(tenant.meter_id) ?? 0) + 1
      );
    }
  }

  function isSharedMeter(meterId: string | null): boolean {
    if (!meterId) return false;
    return (meterAssignmentCounts.get(meterId) ?? 0) > 1;
  }

  function getMeterName(meterId: string | null): string {
    if (!meterId) return "Unassigned";
    const meter = meters.find((m) => m.id === meterId);
    return meter?.name ?? "Unknown meter";
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (!newName.trim()) {
      setError("Name is required");
      return;
    }

    setAddSaving(true);

    const { error: insertError } = await supabase.from("tenants").insert({
      microgrid_id: microgridId,
      name: newName.trim(),
      phone: newPhone.trim() || null,
      email: newEmail.trim() || null,
      meter_id: null,
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

  function startEdit(tenant: Tenant) {
    setEditingId(tenant.id);
    setEditName(tenant.name);
    setEditPhone(tenant.phone ?? "");
    setEditEmail(tenant.email ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
  }

  async function handleEditSave(tenantId: string) {
    setError(null);

    if (!editName.trim()) {
      setError("Name is required");
      return;
    }

    setEditSaving(true);

    const { error: updateError } = await supabase
      .from("tenants")
      .update({
        name: editName.trim(),
        phone: editPhone.trim() || null,
        email: editEmail.trim() || null,
      })
      .eq("id", tenantId);

    if (updateError) {
      setError(updateError.message);
      setEditSaving(false);
      return;
    }

    setEditingId(null);
    setEditSaving(false);
    router.refresh();
  }

  function openDeleteDialog(tenant: Tenant) {
    setTenantToDelete(tenant);
    setDeleteDialogOpen(true);
  }

  async function handleDelete() {
    if (!tenantToDelete) return;
    const { error: deleteError } = await supabase
      .from("tenants")
      .delete()
      .eq("id", tenantToDelete.id);

    if (deleteError) {
      throw new Error(deleteError.message);
    }

    router.refresh();
  }

  async function handleMeterChange(tenantId: string, meterId: string) {
    setError(null);

    const { error: updateError } = await supabase
      .from("tenants")
      .update({ meter_id: meterId || null })
      .eq("id", tenantId);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    router.refresh();
  }

  return (
    <div className="rounded-lg border border-border bg-card p-6">
      {/* Delete Tenant ConfirmDialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="Delete tenant?"
        description={
          tenantToDelete
            ? `Are you sure you want to delete "${tenantToDelete.name}"?`
            : undefined
        }
        confirmLabel="Delete"
        tone="destructive"
        onConfirm={handleDelete}
      />

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Tenants</h2>
        <button
          onClick={() => setShowAddForm(!showAddForm)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:opacity-90"
        >
          {showAddForm ? "Cancel" : "Add Tenant"}
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
              placeholder="Tenant name"
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
            {addSaving ? "Adding..." : "Add Tenant"}
          </button>
        </form>
      )}

      {tenants.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tenants yet. Add a tenant to get started.
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
                  Assigned Meter
                </th>
                <th className="pb-2 font-medium text-muted-foreground">Actions</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id} className="border-b border-border">
                  {editingId === tenant.id ? (
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
                          {getMeterName(tenant.meter_id)}
                        </span>
                      </td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => handleEditSave(tenant.id)}
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
                        {tenant.name}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {tenant.phone ?? "-"}
                      </td>
                      <td className="py-3 pr-4 text-muted-foreground">
                        {tenant.email ?? "-"}
                      </td>
                      <td className="py-3 pr-4">
                        <div>
                          <select
                            value={tenant.meter_id ?? ""}
                            onChange={(e) =>
                              handleMeterChange(tenant.id, e.target.value)
                            }
                            className="rounded-md border border-border px-2 py-1 text-sm text-foreground focus:outline-none"
                          >
                            <option value="">Unassigned</option>
                            {meters.map((meter) => (
                              <option key={meter.id} value={meter.id}>
                                {meter.meter_type ? `[${meter.meter_type}] ` : ""}{meter.name}
                              </option>
                            ))}
                          </select>
                          <p className="mt-1 text-xs text-muted-foreground">
                            Assign a CONSUMPTION meter to bill this tenant for their electricity usage.
                          </p>
                          {isSharedMeter(tenant.meter_id) && (
                            <p className="mt-1 text-xs text-warning-fg">
                              Shared with another tenant
                            </p>
                          )}
                        </div>
                      </td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <button
                            onClick={() => startEdit(tenant)}
                            className="rounded-md px-2 py-1 text-sm text-primary hover:bg-accent"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => openDeleteDialog(tenant)}
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
