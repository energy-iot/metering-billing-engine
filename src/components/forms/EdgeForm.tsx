"use client";

/**
 * EdgeForm — Edit an Edge (post-#101).
 *
 * Modal via Radix Dialog. Fields: name, openems_edge_id, role.
 *
 * Post-#101 product decisions:
 *   - `data_source_type` is gone (OpenEMS is the only type).
 *   - `openems_backend_url` moved to microgrids.ems_backend_url — configure it
 *     on the OpenEMS Backend tab (shipping in #102/#103).
 *   - Manual create path is retired: new edges come from the Discover flow
 *     (POST /api/microgrids/[id]/edges/register via the Add Edge dialog,
 *     shipping in #103). This form is therefore edit-only for now; the
 *     create branch is retained as a structural placeholder until the
 *     Discover dialog lands, and will raise a clear "use Discover" message
 *     if someone hits it.
 *
 * Posts to /api/edges/[id] (PATCH).
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import type { Edge } from "@/lib/types/domain";

// ── Props ─────────────────────────────────────────────────────────────────

type CreateProps = {
  mode: "create";
  parentMicrogridId: string;
  edge?: never;
};

type EditProps = {
  mode: "edit";
  edge: Edge;
  parentMicrogridId?: never;
};

export type EdgeFormProps = (CreateProps | EditProps) & {
  /** Called after successful save so the parent can close the modal. */
  onSuccess: () => void;
  /** Called when the user cancels without saving. */
  onCancel: () => void;
};

// ── Component ─────────────────────────────────────────────────────────────

export function EdgeForm({ mode, edge, onSuccess, onCancel }: EdgeFormProps) {
  const router = useRouter();

  // Form state
  const [name, setName] = React.useState(mode === "edit" ? (edge.name ?? "") : "");
  const [openemsEdgeId, setOpenemsEdgeId] = React.useState(
    mode === "edit" ? (edge.openems_edge_id ?? "") : ""
  );
  const [role, setRole] = React.useState(mode === "edit" ? (edge.role ?? "") : "");

  // UI state
  const [saving, setSaving] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setFieldErrors({});

    if (mode === "create") {
      // Post-#101: manual create is retired — direct users to Discover.
      setServerError(
        "Manual edge creation is retired. Open the Discover Edges dialog from the Edges tab (shipping in #103)."
      );
      return;
    }

    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Name is required.";
    if (!openemsEdgeId.trim()) errors.openems_edge_id = "OpenEMS edge ID is required.";
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      openems_edge_id: openemsEdgeId.trim(),
      role: role.trim() || null,
    };

    setSaving(true);
    try {
      const res = await fetch(`/api/edges/${edge.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (res.ok) {
        router.refresh();
        onSuccess();
        return;
      }

      let json: { error?: string } = {};
      try {
        json = await res.json();
      } catch {
        // ignore parse error
      }

      setServerError(json.error ?? `Unexpected error (HTTP ${res.status})`);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  const canSave = name.trim().length > 0 && openemsEdgeId.trim().length > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {/* Server error banner */}
      {serverError && (
        <Banner tone="destructive" title="Could not save edge">
          {serverError}
        </Banner>
      )}

      {/* Name */}
      <div>
        <label
          htmlFor="edge-name"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Name <span aria-hidden="true">*</span>
        </label>
        <Input
          id="edge-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Metering Pi, Storage Gateway…"
          required
          aria-required="true"
          aria-describedby={fieldErrors.name ? "edge-name-error" : undefined}
        />
        {fieldErrors.name && (
          <p id="edge-name-error" role="alert" className="mt-1 text-xs text-destructive-fg">
            {fieldErrors.name}
          </p>
        )}
      </div>

      {/* OpenEMS Edge ID */}
      <div>
        <label
          htmlFor="edge-openems-edge-id"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          OpenEMS Edge ID <span aria-hidden="true">*</span>
        </label>
        <Input
          id="edge-openems-edge-id"
          value={openemsEdgeId}
          onChange={(e) => setOpenemsEdgeId(e.target.value)}
          placeholder="edge0"
          required
          aria-required="true"
          aria-describedby={
            fieldErrors.openems_edge_id ? "edge-openems-edge-id-error" : undefined
          }
        />
        {fieldErrors.openems_edge_id && (
          <p
            id="edge-openems-edge-id-error"
            role="alert"
            className="mt-1 text-xs text-destructive-fg"
          >
            {fieldErrors.openems_edge_id}
          </p>
        )}
      </div>

      {/* Role (optional, free-form) */}
      <div>
        <label
          htmlFor="edge-role"
          className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Role <span className="font-normal normal-case text-muted-foreground">(optional)</span>
        </label>
        <Input
          id="edge-role"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="metering | storage | ev | …"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving || !canSave}
          className={cn(
            "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
        >
          {saving ? "Saving…" : mode === "create" ? "Add edge" : "Save changes"}
        </button>
      </div>
    </form>
  );
}

// ── Modal wrapper ─────────────────────────────────────────────────────────
// Separating the Dialog shell from the form body keeps EdgeForm testable
// without a full DOM environment for the portal.

export type EdgeFormModalProps = (CreateProps | EditProps) & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function EdgeFormModal({ open, onOpenChange, ...formProps }: EdgeFormModalProps) {
  const title = formProps.mode === "create" ? "Add edge" : "Edit edge";
  const description =
    formProps.mode === "create"
      ? "Manual creation is retired — use the Discover Edges dialog instead (shipping in #103)."
      : "Update the edge configuration.";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55 data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content
          aria-modal
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "overflow-y-auto max-h-[90vh] rounded-md border border-border bg-card shadow-elev-3 outline-none"
          )}
        >
          {/* Top accent rail */}
          <div aria-hidden="true" className="h-[6px] bg-primary" />

          <div className="space-y-1 px-6 pt-5 pb-2">
            <Dialog.Title className="text-base font-semibold text-foreground">
              {title}
            </Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground">
              {description}
            </Dialog.Description>
          </div>

          <div className="px-6 pb-6">
            <EdgeForm
              {...formProps}
              onSuccess={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
