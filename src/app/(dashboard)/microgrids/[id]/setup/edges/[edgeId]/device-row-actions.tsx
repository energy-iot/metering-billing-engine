"use client";

/**
 * DeviceRowActions — client shell for the per-device kebab on the edge detail
 * page (#151).
 *
 * Renders a kebab affordance ("⋮") that opens a dropdown with a single
 * "Edit device" item. Selecting it opens <DeviceEditDialog>. Permission gate
 * is already applied at the parent (the kebab is only rendered when
 * canManage). Pattern mirrors HouseholdRowActions in HouseholdTable.tsx.
 */

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { DeviceEditDialog } from "@/components/forms/DeviceEditDialog";
import type { DeviceEditDialogDevice } from "@/components/forms/DeviceEditDialog";

export function DeviceRowActions({ device }: { device: DeviceEditDialogDevice }) {
  const [editing, setEditing] = React.useState(false);

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${device.name}`}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <KebabIcon />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-[160px] rounded-md border border-border bg-card p-1 shadow-elev-2"
          >
            <DropdownMenu.Item
              onSelect={() => setEditing(true)}
              className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] text-foreground outline-none data-[highlighted]:bg-muted"
            >
              Edit device
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {editing && (
        <DeviceEditDialog
          open={editing}
          onOpenChange={setEditing}
          device={device}
        />
      )}
    </>
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
