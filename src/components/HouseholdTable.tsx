"use client";

/**
 * HouseholdTable — list of households on a microgrid (#145 refactor).
 *
 * What this file does NOT do anymore:
 *   - No inline create form (HouseholdsSection wraps HouseholdWizard)
 *   - No inline name/phone/email edit (HouseholdEditDialog covers it)
 *   - No per-row inline billing-device <select> (HouseholdEditDialog covers
 *     it via DeviceSelect; superseded the #144 <optgroup> work)
 *
 * What this file DOES:
 *   - Renders one row per household with: stacked name + contact, address
 *     summary, click-to-edit billing-device chip, kebab menu
 *   - Kebab menu (Radix DropdownMenu, used directly per edge-row-actions
 *     pattern; no ui/dropdown-menu wrapper exists):
 *       Edit household           → opens HouseholdEditDialog
 *       Change/Link billing dev. → opens HouseholdEditDialog
 *       View detail →            → Link to detail page
 *       — separator —
 *       Delete household         → existing destructive flow
 *   - Click-to-edit chip column:
 *       Assigned   → <button> wrapping <Chip tone="success" dot>
 *       Unassigned → <button> wrapping <Chip tone="warn" dot>
 *     Real <button> + explicit aria-label so focus ring + keyboard
 *     activation come for free.
 *   - Address column: today's 3 fields joined; #146 widens.
 *
 * Permission: kebab + chip-button render only when canManage. For non-
 * managers the chip is a non-interactive <span>.
 *
 * BillingDeviceOption was added in #144 for the now-superseded native
 * <select>/<optgroup>. The shape carries the fields DeviceSelect needs
 * (edge_id, edge_name, linkedToHouseholdName) so it is reused as the prop
 * shape unchanged. Marking it deprecated would force callers to convert
 * shapes for no reason — leave the type in place as the public surface.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { createClient } from "@/lib/supabase/client";
import type { Device, Household } from "@/lib/types/domain";
import { Chip } from "@/components/ui/chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { HouseholdEditDialog } from "@/components/forms/HouseholdEditDialog";

/**
 * An enriched device option for the billing-device picker. Carries
 * edge_id + edge_name (DeviceSelect groups by edge_id, labels with
 * edge_name) and an optional linkedToHouseholdName when the device is
 * already the primary_consumption_meter of a different household on this
 * microgrid.
 *
 * Originally introduced in #144 for the native <select>/<optgroup>. After
 * the #145 refactor the same shape feeds DeviceSelect — kept as the
 * canonical billing-device shape rather than renamed to avoid a churning
 * caller diff.
 */
export type BillingDeviceOption = {
  id: string;
  name: string;
  device_type: string;
  edge_id: string;
  edge_name: string;
  /** Set when this device is already assigned as primary_consumption_meter
   *  on a DIFFERENT household. DeviceSelect renders these greyed + disabled. */
  linkedToHouseholdName?: string | null;
};

interface Props {
  microgridId: string;
  households: Household[];
  /** Flat device list — used by the "current device" lookup in chip column. */
  devices: Device[];
  /** Enriched device list for the edit dialog's DeviceSelect. */
  billingDevices?: BillingDeviceOption[];
  /** household_id → device_id for primary_consumption_meter rows */
  primaryDeviceAssignments: Record<string, string>;
  canManage?: boolean;
  /** Called when the user clicks the "Add household" CTA in the empty state. */
  onAdd?: () => void;
  /** Edges discovery page href — surfaced in DeviceSelect's empty state. */
  microgridEdgesSetupHref?: string;
}

export function HouseholdTable({
  microgridId,
  households,
  devices,
  billingDevices,
  primaryDeviceAssignments,
  canManage = false,
  onAdd,
  microgridEdgesSetupHref,
}: Props) {
  const router = useRouter();
  const supabase = createClient();

  // Edit dialog
  const [editing, setEditing] = React.useState<Household | null>(null);

  // Delete dialog
  const [householdToDelete, setHouseholdToDelete] =
    React.useState<Household | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);

  // Map of household_id → display_name (for DeviceSelect's "linked to"
  // suffix). Use this to enrich billingDevices on the fly.
  const householdNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const h of households) m.set(h.id, h.display_name);
    return m;
  }, [households]);

  // device_id → owning household name (only for assigned devices that
  // belong to another household on this microgrid).
  const deviceLinkedHouseholdName = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const [hhId, devId] of Object.entries(primaryDeviceAssignments)) {
      const name = householdNameById.get(hhId);
      if (name) m.set(devId, name);
    }
    return m;
  }, [primaryDeviceAssignments, householdNameById]);

  /**
   * Build the DeviceSelect prop list for THIS row. We rebuild rather than
   * passing a global list because the linked-elsewhere set depends on the
   * row's own currentDeviceId (the dialog component itself also strips
   * linked-to on the matching id, but doing it here keeps the prop list
   * small and deterministic per row).
   */
  function devicesForHousehold(householdId: string): BillingDeviceOption[] {
    const ownDeviceId = primaryDeviceAssignments[householdId];
    const source =
      billingDevices ??
      // Fallback: derive a thin list from the flat `devices` prop. Edge
      // grouping degrades to a single "(unknown edge)" group when this
      // path is used. Callers should always pass `billingDevices`.
      devices.map<BillingDeviceOption>((d) => ({
        id: d.id,
        name: d.name,
        device_type: d.device_type,
        edge_id: d.edge_id,
        edge_name: "",
      }));

    return source.map((d) => {
      // The device that's CURRENTLY linked to this household must not
      // appear with a "linked to …" suffix in this row's picker.
      if (d.id === ownDeviceId) {
        return { ...d, linkedToHouseholdName: null };
      }
      // Devices linked to OTHER households get the suffix.
      const ownerName = deviceLinkedHouseholdName.get(d.id);
      if (ownerName) {
        return { ...d, linkedToHouseholdName: ownerName };
      }
      return { ...d, linkedToHouseholdName: null };
    });
  }

  function getDeviceForHousehold(
    householdId: string
  ): { name: string; edge_name: string } | null {
    const deviceId = primaryDeviceAssignments[householdId];
    if (!deviceId) return null;
    const enriched = billingDevices?.find((d) => d.id === deviceId);
    if (enriched) {
      return { name: enriched.name, edge_name: enriched.edge_name };
    }
    const flat = devices.find((d) => d.id === deviceId);
    if (flat) {
      return { name: flat.name, edge_name: "" };
    }
    return null;
  }

  function addressSummary(h: Household): string {
    const parts = [h.address_line1, h.unit_label].filter(Boolean) as string[];
    return parts.length > 0 ? parts.join(" · ") : "—";
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

  return (
    <div className="rounded-lg border border-border bg-card p-6">
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

      {editing && (
        <HouseholdEditDialog
          open={Boolean(editing)}
          onOpenChange={(o) => {
            if (!o) setEditing(null);
          }}
          household={editing}
          availableDevices={devicesForHousehold(editing.id)}
          currentDeviceId={primaryDeviceAssignments[editing.id] ?? null}
          edgesSetupHref={
            microgridEdgesSetupHref ??
            `/microgrids/${microgridId}/setup/edges`
          }
        />
      )}

      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">Households</h2>
      </div>

      {households.length === 0 ? (
        <EmptyState
          eyebrow="Households"
          title="Add the first household"
          body={
            <>
              Households are the customers on this microgrid. Each gets their
              own bill. Add them now; link their meter later.
            </>
          }
          cta={
            canManage && onAdd ? (
              <button
                type="button"
                onClick={onAdd}
                className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
              >
                + Add household
              </button>
            ) : undefined
          }
          footnote={
            !canManage
              ? "Ask a super admin to add households for this microgrid."
              : undefined
          }
          className="border-0 shadow-none bg-transparent p-0"
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">
              Households on this microgrid
            </caption>
            <thead>
              <tr className="border-b border-border text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Household</th>
                <th className="pb-2 pr-4 font-medium">Address</th>
                <th className="pb-2 pr-4 font-medium">Billing device</th>
                <th className="pb-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {households.map((household) => {
                const device = getDeviceForHousehold(household.id);
                return (
                  <tr
                    key={household.id}
                    className="border-b border-border align-top"
                  >
                    <td className="py-3 pr-4">
                      <div className="font-medium text-foreground">
                        {household.display_name}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {[household.primary_email, household.primary_phone]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </div>
                    </td>
                    <td className="py-3 pr-4 text-muted-foreground">
                      <span className="block max-w-[260px] truncate">
                        {addressSummary(household)}
                      </span>
                    </td>
                    <td className="py-3 pr-4">
                      <BillingDeviceCell
                        household={household}
                        device={device}
                        canManage={canManage}
                        onEdit={() => setEditing(household)}
                      />
                    </td>
                    <td className="py-3 text-right">
                      {canManage ? (
                        <HouseholdRowActions
                          household={household}
                          microgridId={microgridId}
                          hasDevice={Boolean(device)}
                          onEdit={() => setEditing(household)}
                          onDelete={() => openDeleteDialog(household)}
                        />
                      ) : (
                        <Link
                          href={`/microgrids/${microgridId}/setup/households/${household.id}`}
                          className="rounded-md px-2 py-1 text-sm text-primary hover:bg-accent"
                        >
                          View
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Cell + actions ───────────────────────────────────────────────────────

function BillingDeviceCell({
  household,
  device,
  canManage,
  onEdit,
}: {
  household: Household;
  device: { name: string; edge_name: string } | null;
  canManage: boolean;
  onEdit: () => void;
}) {
  if (!canManage) {
    if (device) {
      return (
        <Chip tone="success" dot>
          {device.name}
          {device.edge_name ? (
            <span className="ml-1 text-[11px] text-muted-foreground">
              · {device.edge_name}
            </span>
          ) : null}
        </Chip>
      );
    }
    return (
      <Chip tone="warn" dot>
        Unassigned
      </Chip>
    );
  }

  if (device) {
    return (
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Change billing device for ${household.display_name}`}
        className="inline-flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Chip tone="success" dot>
          {device.name}
          {device.edge_name ? (
            <span className="ml-1 text-[11px] text-muted-foreground">
              · {device.edge_name}
            </span>
          ) : null}
        </Chip>
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onEdit}
      aria-label={`Link a billing device for ${household.display_name}`}
      className="inline-flex items-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Chip tone="warn" dot>
        Unassigned
      </Chip>
    </button>
  );
}

function HouseholdRowActions({
  household,
  microgridId,
  hasDevice,
  onEdit,
  onDelete,
}: {
  household: Household;
  microgridId: string;
  hasDevice: boolean;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${household.display_name}`}
          className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <KebabIcon />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          sideOffset={4}
          className="z-50 min-w-[180px] rounded-md border border-border bg-card p-1 shadow-elev-2"
        >
          <DropdownMenu.Item
            onSelect={onEdit}
            className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] text-foreground outline-none data-[highlighted]:bg-muted"
          >
            Edit household
          </DropdownMenu.Item>
          <DropdownMenu.Item
            onSelect={onEdit}
            className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] text-foreground outline-none data-[highlighted]:bg-muted"
          >
            {hasDevice ? "Change billing device" : "Link device"}
          </DropdownMenu.Item>
          <DropdownMenu.Item asChild>
            <Link
              href={`/microgrids/${microgridId}/setup/households/${household.id}`}
              className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] text-foreground outline-none data-[highlighted]:bg-muted"
            >
              View detail →
            </Link>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item
            onSelect={onDelete}
            className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] text-destructive-fg outline-none data-[highlighted]:bg-destructive-muted"
          >
            Delete household
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function KebabIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <circle cx="8" cy="3" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="8" cy="13" r="1.25" />
    </svg>
  );
}
