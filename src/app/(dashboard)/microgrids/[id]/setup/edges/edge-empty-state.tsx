"use client";

/**
 * EdgeEmptyState — client wrapper for the edges listing empty state (#139 P4).
 *
 * Handles local dialog state for the "Add edge" CTA. The edges listing page
 * is a server component; this thin client shell owns the AddEdgeDialog open
 * state so the CTA can be interactive.
 *
 * Tone is always neutral (§G in the refinement): the top-of-page <Banner>
 * already owns the warn signal when emsType === null. Duplicating with another
 * warn tone creates double-warning noise.
 *
 * CTA gating:
 *   - canManage && emsType !== null → show + Add edge button
 *   - emsType === null → show secondary link to OpenEMS backend config +
 *     neutral footnote (banner already warns)
 *   - !canManage → footnote only
 */

import * as React from "react";
import Link from "next/link";
import { EmptyState } from "@/components/ui/empty-state";
import { AddEdgeDialog } from "@/components/forms/AddEdgeDialog";

type Props = {
  microgridId: string;
  canManage: boolean;
  emsType: string | null;
};

export function EdgeEmptyState({ microgridId, canManage, emsType }: Props) {
  const [open, setOpen] = React.useState(false);
  const blockedOnBackend = emsType === null;

  return (
    <>
      <EmptyState
        eyebrow="Edges"
        title="Add the first edge"
        body={
          <>
            An edge connects this microgrid to its meters — typically an
            OpenEMS instance running on a gateway device at your site.
          </>
        }
        cta={
          canManage && !blockedOnBackend ? (
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex items-center rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              + Add edge
            </button>
          ) : undefined
        }
        secondary={
          blockedOnBackend ? (
            <Link
              href={`/microgrids/${microgridId}/setup/openems-backend`}
              className="text-sm font-medium text-foreground underline hover:opacity-80"
            >
              Configure OpenEMS backend →
            </Link>
          ) : undefined
        }
        footnote={
          blockedOnBackend
            ? "Configure the OpenEMS backend first, then add an edge."
            : !canManage
              ? "Ask a super admin to add the first edge."
              : undefined
        }
      />
      {canManage && !blockedOnBackend && (
        <AddEdgeDialog
          microgridId={microgridId}
          open={open}
          onOpenChange={setOpen}
        />
      )}
    </>
  );
}
