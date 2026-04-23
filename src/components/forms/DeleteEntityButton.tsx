"use client";

/**
 * DeleteEntityButton — client wrapper for the #89 entity-delete flow.
 *
 * Colocated with `EditEntityButton`; one implementation is reused by the
 * four entity detail pages (organization / community / microgrid / edge).
 * Permission gating lives in the PARENT server component — do NOT render
 * this button if the server-side access check failed. This client
 * component has no auth surface of its own.
 *
 * End-to-end click flow (AC-UI-3):
 *   1. Button click → `isOpening = true`, the button goes `disabled`,
 *      fire `GET /api/<kind>/<id>/delete-preview`.
 *   2. Preview 200 → store response, clear `isOpening`, open the
 *      `<ConfirmDialog>` with `requireTypedConfirmation` + the
 *      `<BlastRadiusList>` body.
 *   3. Preview 403/404/500 → clear `isOpening`, DO NOT open the dialog,
 *      surface a `<Banner tone="destructive">` inline on the detail page
 *      using `data.error`.
 *   4. User types name, clicks Confirm → ConfirmDialog's internal async
 *      confirm fires `DELETE /api/<kind>/<id>`.
 *   5. DELETE 204 → `router.refresh()` then `router.push(<parent-path>)`
 *      with `?deleted=<kind>&name=<encoded-name>` so the parent page can
 *      render its success banner (AC-UI-7).
 *   6. DELETE error → throw from the confirm handler; ConfirmDialog
 *      renders the error inline and keeps the dialog open. User can
 *      Retry or Cancel.
 *   7. Cancel-then-reopen → always re-fetch preview; never cache in
 *      component state across opens.
 *
 * Visual style: cloned from #79's Revoke button at
 * `src/components/users/EditUserDialog.tsx:353-358` for consistency with
 * other destructive affordances shipped recently.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Banner } from "@/components/ui/banner";
import { BlastRadiusList } from "@/components/entity-deletion/BlastRadiusList";
import type { DescendantCounts, EntityKind } from "@/lib/entity-descendants";

// Parent redirect shape matches the preview response.
type Parent =
  | { kind: "organization"; id: string }
  | { kind: "community"; id: string }
  | { kind: "microgrid"; id: string }
  | null;

interface PreviewResponse {
  entity: { id: string; name: string };
  descendant_counts: DescendantCounts;
  as_of: string;
  parent: Parent;
}

export interface DeleteEntityButtonProps {
  entity: EntityKind;
  id: string;
  name: string;
}

const KIND_LABEL: Record<EntityKind, string> = {
  organization: "Organization",
  community: "Community",
  microgrid: "Microgrid",
  edge: "Edge",
};

function apiBaseFor(entity: EntityKind): string {
  switch (entity) {
    case "organization":
      return "/api/organizations";
    case "community":
      return "/api/communities";
    case "microgrid":
      return "/api/microgrids";
    case "edge":
      return "/api/edges";
  }
}

function parentPathFor(entity: EntityKind, parent: Parent): string {
  // Parent path resolution per AC-UI-3 step 5.
  if (entity === "organization") {
    return "/organizations";
  }
  if (!parent) return "/";
  switch (parent.kind) {
    case "organization":
      return `/organizations/${parent.id}`;
    case "community":
      return `/communities/${parent.id}`;
    case "microgrid":
      // For edge deletes, redirect back to the edges sub-route.
      if (entity === "edge") return `/microgrids/${parent.id}/setup/edges`;
      return `/microgrids/${parent.id}`;
  }
}

export function DeleteEntityButton({ entity, id, name }: DeleteEntityButtonProps) {
  const router = useRouter();
  const [isOpening, setIsOpening] = React.useState(false);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<PreviewResponse | null>(null);
  const [topError, setTopError] = React.useState<string | null>(null);

  const kindLabel = KIND_LABEL[entity];

  async function handleOpen() {
    setTopError(null);
    setIsOpening(true);
    try {
      const res = await fetch(`${apiBaseFor(entity)}/${id}/delete-preview`, {
        method: "GET",
        // Default credentials: include cookies so the session authenticates.
      });
      if (!res.ok) {
        let errMsg = `Unable to load delete preview (${res.status}).`;
        try {
          const data = (await res.json()) as { error?: string };
          if (data.error) errMsg = data.error;
        } catch {
          // body not JSON — stick with default message.
        }
        setTopError(errMsg);
        setIsOpening(false);
        return;
      }
      const data = (await res.json()) as PreviewResponse;
      setPreview(data);
      setDialogOpen(true);
      setIsOpening(false);
    } catch (err) {
      setTopError(
        err instanceof Error
          ? err.message
          : "Unable to load delete preview."
      );
      setIsOpening(false);
    }
  }

  async function handleConfirm(): Promise<void> {
    if (!preview) throw new Error("Delete preview is missing.");
    const res = await fetch(`${apiBaseFor(entity)}/${id}`, {
      method: "DELETE",
    });
    if (res.status === 204) {
      // Bust the Server-Component cache for the CURRENT route, then push.
      // The DELETE route also calls `revalidatePath(..., "layout")` for
      // parent-scoped trees (AC-UI-6), so the combination covers both
      // the current route and nav/sidebar caches.
      router.refresh();
      const parentPath = parentPathFor(entity, preview.parent);
      const qs = new URLSearchParams({
        deleted: entity,
        name: preview.entity.name,
      }).toString();
      const target =
        parentPath + (parentPath.includes("?") ? "&" : "?") + qs;
      router.push(target);
      return;
    }
    // Non-204 → throw with the server error so ConfirmDialog renders it.
    let msg = `Failed to delete ${kindLabel.toLowerCase()}.`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) msg = data.error;
    } catch {
      // body wasn't JSON — use default.
    }
    throw new Error(msg);
  }

  // Clear the preview when the dialog closes so we always re-fetch on reopen.
  React.useEffect(() => {
    if (!dialogOpen) {
      setPreview(null);
    }
  }, [dialogOpen]);

  // Style mirrors #79's Revoke button (destructive tokenized).
  const btnCls =
    "inline-flex h-8 items-center rounded-md border border-destructive bg-destructive-muted px-3.5 text-[13px] font-medium text-destructive-fg hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed";

  return (
    <>
      <button
        type="button"
        onClick={handleOpen}
        disabled={isOpening}
        className={btnCls}
      >
        {isOpening ? `Loading…` : `Delete ${kindLabel}`}
      </button>
      {topError && (
        <div className="mt-2">
          <Banner tone="destructive" title={`Couldn’t open delete dialog`}>
            {topError}
          </Banner>
        </div>
      )}
      {preview && (
        <ConfirmDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          tone="destructive"
          title={`Delete ${kindLabel.toLowerCase()} “${name}”?`}
          description={`This cannot be undone. Type “${name}” to confirm.`}
          body={
            <BlastRadiusList
              counts={preview.descendant_counts}
              asOf={preview.as_of}
            />
          }
          confirmLabel={`Delete ${kindLabel.toLowerCase()}`}
          requireTypedConfirmation={{
            label: `Type ${kindLabel.toLowerCase()} name to confirm`,
            expected: preview.entity.name,
          }}
          onConfirm={handleConfirm}
        />
      )}
    </>
  );
}
