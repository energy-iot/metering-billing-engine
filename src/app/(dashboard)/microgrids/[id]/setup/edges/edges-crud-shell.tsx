"use client";

/**
 * EdgesCRUDShell — client-side shell for "+ Add Edge" and "Configure…" buttons.
 *
 * Rendered inside the server component SetupEdgesPage. Splits the modal state
 * into a thin client wrapper so the page's server component can remain async.
 *
 * Two modes:
 *   "add-button"      → renders the "+ Add edge" button that opens EdgeFormModal in create mode
 *   "configure-button" → renders the "Configure…" link button for a specific edge row
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import type { Edge } from "@/lib/types/domain";
import { EdgeFormModal } from "@/components/forms/EdgeForm";

type AddButtonProps = {
  mode: "add-button";
  microgridId: string;
  edge?: never;
};

type ConfigureButtonProps = {
  mode: "configure-button";
  microgridId: string;
  edge: Edge;
};

export type EdgesCRUDShellProps = AddButtonProps | ConfigureButtonProps;

export function EdgesCRUDShell({ mode, microgridId, edge }: EdgesCRUDShellProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  if (mode === "add-button") {
    return (
      <>
        <button
          onClick={() => setOpen(true)}
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          + Add edge
        </button>
        <EdgeFormModal
          mode="create"
          parentMicrogridId={microgridId}
          open={open}
          onOpenChange={(next) => {
            setOpen(next);
            if (!next) router.refresh();
          }}
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
        mode="edit"
        edge={edge}
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) router.refresh();
        }}
      />
    </>
  );
}
