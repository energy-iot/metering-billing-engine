"use client";

/**
 * EdgesCRUDShell — client-side shell for "+ Add Edge" and "Configure…" buttons.
 *
 * Rendered inside the server component SetupEdgesPage. Splits the modal state
 * into a thin client wrapper so the page's server component can remain async.
 *
 * Two modes:
 *   "add-button"      → renders the "+ Add edge" button (currently disabled,
 *                       pending the Discover-only Add Edge dialog in #103)
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- microgridId forwarded to AddEdgeDialog in #103
export function EdgesCRUDShell({ mode, microgridId, edge }: EdgesCRUDShellProps) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);

  if (mode === "add-button") {
    // TODO #103: Replace this stub with <AddEdgeDialog> once the Discover-only
    // Add Edge dialog lands. The create branch was removed from EdgeFormModal in
    // #104; this disabled button keeps the shell compilable until #103 ships.
    return (
      <button
        type="button"
        disabled
        title="Add Edge is moving to Discover-only (coming in #103)."
        className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground opacity-50 cursor-not-allowed"
      >
        + Add edge
      </button>
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
