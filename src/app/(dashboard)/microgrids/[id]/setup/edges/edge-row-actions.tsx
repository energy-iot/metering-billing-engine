"use client";

/**
 * EdgeRowActions — per-row kebab menu for the Setup > Edges listing.
 *
 * Replaces the standalone `EdgesCRUDShell mode="configure-button"` in the
 * actions column. Wraps the Configure action in a Radix DropdownMenu and
 * conditionally adds a Delete action (gated on `canManage`, resolved
 * server-side by the listing page).
 *
 * Design: kebab scaffolds future Discover-workstream actions (Rediscover,
 * Reassign) without further row-shape churn (#100 context note).
 *
 * Permission model:
 *   `canManage` is a UX-only affordance — the Delete item is hidden from
 *   non-managers. The actual authorization backstop lives in the API route
 *   (`GET /api/edges/[id]/delete-preview` returns 403 on failure).
 *
 * Server-client boundary:
 *   The listing page resolves `canManage` server-side once and passes it
 *   here as a prop — no per-row fetch.
 *
 * DeleteEntityButton wiring:
 *   The component renders its own button + ConfirmDialog as a React Fragment.
 *   We render it outside the DropdownMenu.Portal to avoid z-index/portal
 *   conflicts and trigger it from the menu item's `onSelect` via an
 *   imperative ref click on the inner button.
 */

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useRouter } from "next/navigation";
import { DeleteEntityButton } from "@/components/forms/DeleteEntityButton";
import { EdgeFormModal } from "@/components/forms/EdgeForm";
import type { Edge } from "@/lib/types/domain";

interface EdgeRowActionsProps {
  edge: Pick<
    Edge,
    | "id"
    | "name"
    | "data_source_type"
    | "openems_edge_id"
    | "openems_backend_url"
    | "role"
  >;
  microgridId: string;
  canManage: boolean;
}

export function EdgeRowActions({
  edge,
  canManage,
}: EdgeRowActionsProps) {
  const router = useRouter();
  const [configureOpen, setConfigureOpen] = React.useState(false);
  // Ref on a wrapper div that contains DeleteEntityButton's internal button.
  // onSelect in the Delete menu item imperatively clicks it so the
  // DeleteEntityButton's handleOpen fires after the menu closes.
  const deleteWrapperRef = React.useRef<HTMLDivElement>(null);

  function triggerDelete() {
    deleteWrapperRef.current?.querySelector("button")?.click();
  }

  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Edge actions"
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
            {/* Configure — always visible; opens EdgeFormModal in edit mode */}
            <DropdownMenu.Item
              onSelect={() => setConfigureOpen(true)}
              className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] text-foreground outline-none data-[highlighted]:bg-muted"
            >
              Configure…
            </DropdownMenu.Item>

            {/* Delete — only when canManage */}
            {canManage && (
              <>
                <DropdownMenu.Separator className="my-1 h-px bg-border" />
                <DropdownMenu.Item
                  onSelect={triggerDelete}
                  className="flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-[13px] text-destructive-fg outline-none data-[highlighted]:bg-destructive-muted"
                >
                  Delete edge
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* DeleteEntityButton rendered outside the portal so its ConfirmDialog
          stacks above the (already-closed) menu without z-index conflicts.
          Visually hidden wrapper — the button inside is triggered imperatively. */}
      {canManage && (
        <div
          ref={deleteWrapperRef}
          className="sr-only"
          data-testid="delete-entity-wrapper"
        >
          <DeleteEntityButton
            entity="edge"
            id={edge.id}
            name={edge.name}
          />
        </div>
      )}

      {/* Configure modal — rendered as a sibling so it is not affected by
          DropdownMenu portal lifecycle. */}
      <EdgeFormModal
        mode="edit"
        edge={edge as Edge}
        open={configureOpen}
        onOpenChange={(next) => {
          setConfigureOpen(next);
          if (!next) router.refresh();
        }}
      />
    </>
  );
}

/** Vertical three-dot (kebab) icon — inline SVG following hierarchy-nav.tsx pattern. */
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
