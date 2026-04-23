"use client";

/**
 * EdgesCRUDShell — client-side shell for "+ Add Edge" and "Configure…" buttons.
 *
 * Rendered inside the server component SetupEdgesPage. Splits the modal state
 * into a thin client wrapper so the page's server component can remain async.
 *
 * Two modes:
 *   "add-button"      → renders the "+ Add edge" button (gated on ems_type +
 *                       super_admin). Opens <AddEdgeDialog> on click.
 *                       Renders nothing when either gate fails.
 *   "configure-button" → renders the "Configure…" link button for a specific edge row
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Edge } from "@/lib/types/domain";
import { EdgeFormModal } from "@/components/forms/EdgeForm";
import { AddEdgeDialog } from "@/components/forms/AddEdgeDialog";

type AddButtonProps = {
  mode: "add-button";
  microgridId: string;
  /** Microgrid's ems_type column. NULL means the backend is not configured yet. */
  emsType: string | null;
  /** Resolved server-side via currentUserIsSuperAdmin(). */
  isSuperAdmin: boolean;
  edge?: never;
};

type ConfigureButtonProps = {
  mode: "configure-button";
  microgridId: string;
  emsType?: never;
  isSuperAdmin?: never;
  edge: Edge;
};

export type EdgesCRUDShellProps = AddButtonProps | ConfigureButtonProps;

export function EdgesCRUDShell(props: EdgesCRUDShellProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  if (props.mode === "add-button") {
    const { microgridId, emsType, isSuperAdmin } = props;
    // Both gates must pass. Non-super-admins would hit the Discover route's
    // 403 gate (#102); not-yet-configured backends would 409. Prefer rendering
    // nothing to a dead button.
    if (emsType === null || !isSuperAdmin) return null;

    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          + Add edge
        </button>
        <AddEdgeDialog
          microgridId={microgridId}
          open={open}
          onOpenChange={setOpen}
        />
      </>
    );
  }

  // configure-button mode
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="text-xs font-medium text-primary hover:underline"
      >
        Configure…
      </button>
      <EdgeFormModal
        edge={props.edge}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) router.refresh();
        }}
      />
    </>
  );
}
