"use client";

/**
 * EdgeForm — Edit an Edge (post-#104).
 *
 * Modal via Radix Dialog. Edit-only: create path was retired; new edges come
 * from the Discover flow (POST /api/microgrids/[id]/edges/register via the
 * Add Edge dialog, shipping in #103).
 *
 * Fields rendered:
 *   - Name (editable, required)
 *   - OpenEMS Edge ID (readonly display — assigned by Discover, not editable)
 *   - Role (editable, optional free-form)
 *
 * Rediscover button calls the microgrid's Discover endpoint and surfaces an
 * inline banner with the result (found-online / found-offline / not-found /
 * error). Role-drift detection is explicitly out of scope: the discover
 * endpoint returns only { online: boolean } per edge, so there is no
 * server-side component list to diff against edge.role. See #104 Dev Notes.
 *
 * POSTs to /api/edges/[id] (PATCH) with only { name, role }.
 * openems_edge_id is never sent — the server rejects it as of #104.
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import type { Edge } from "@/lib/types/domain";

// ── Props ─────────────────────────────────────────────────────────────────

export type EdgeFormProps = {
  edge: Edge;
  /** Called after successful save so the parent can close the modal. */
  onSuccess: () => void;
  /** Called when the user cancels without saving. */
  onCancel: () => void;
};

// ── Rediscover banner state ───────────────────────────────────────────────

type RediscoverBanner =
  | { kind: "success"; online: boolean }
  | { kind: "not-found" }
  | { kind: "error"; message: string }
  | null;

// ── Component ─────────────────────────────────────────────────────────────

export function EdgeForm({ edge, onSuccess, onCancel }: EdgeFormProps) {
  const router = useRouter();

  // Form state
  const [name, setName] = React.useState(edge.name ?? "");
  const [role, setRole] = React.useState(edge.role ?? "");

  // UI state
  const [saving, setSaving] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  // Rediscover state
  const [rediscovering, setRediscovering] = React.useState(false);
  const [rediscoverBanner, setRediscoverBanner] = React.useState<RediscoverBanner>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setFieldErrors({});

    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Name is required.";
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
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

  async function handleRediscover() {
    setRediscoverBanner(null);
    setRediscovering(true);
    try {
      const res = await fetch(
        `/api/microgrids/${edge.microgrid_id}/openems-backend/discover`,
        { method: "POST", headers: { "Content-Type": "application/json" } }
      );

      let json: {
        status?: string;
        message?: string;
        edges?: Array<{
          openems_edge_id: string;
          name: string;
          metadata: { online: boolean };
          alreadyLinked: boolean;
        }>;
      } = {};
      try {
        json = await res.json();
      } catch {
        // ignore parse error
      }

      if (!res.ok || json.status !== "success") {
        setRediscoverBanner({
          kind: "error",
          message: json.message ?? "Discover failed. Check server logs.",
        });
        return;
      }

      const found = (json.edges ?? []).find(
        (e) => e.openems_edge_id === edge.openems_edge_id
      );

      if (found) {
        setRediscoverBanner({ kind: "success", online: found.metadata.online });
      } else {
        setRediscoverBanner({ kind: "not-found" });
      }
    } catch (err) {
      setRediscoverBanner({
        kind: "error",
        message: err instanceof Error ? err.message : "Network error. Please try again.",
      });
    } finally {
      setRediscovering(false);
    }
  }

  const canSave = name.trim().length > 0;

  return (
    <form onSubmit={handleSubmit} className="space-y-4" noValidate>
      {/* Server error banner */}
      {serverError && (
        <Banner tone="destructive" title="Could not save edge">
          {serverError}
        </Banner>
      )}

      {/* Rediscover result banner */}
      {rediscoverBanner && rediscoverBanner.kind === "success" && (
        <Banner tone="success" title="Edge reachable">
          Edge is reachable on the configured backend (online:{" "}
          {String(rediscoverBanner.online)}).
        </Banner>
      )}
      {rediscoverBanner && rediscoverBanner.kind === "not-found" && (
        <Banner tone="warn" title="Edge not found on backend">
          This edge no longer appears on the configured OpenEMS backend. Check
          the backend config or remove this edge.
        </Banner>
      )}
      {rediscoverBanner && rediscoverBanner.kind === "error" && (
        <Banner tone="destructive" title="Rediscover failed">
          {rediscoverBanner.message}
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

      {/* OpenEMS Edge ID — readonly display */}
      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          OpenEMS Edge ID
        </label>
        <div className="rounded-md bg-muted px-3 py-2 font-mono text-sm text-foreground">
          {edge.openems_edge_id}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          From OpenEMS Discover — not editable. To link a different edge,
          remove this one and rediscover.
        </p>
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
      <div className="flex items-center gap-2 border-t border-border pt-3">
        {/* Rediscover — left side */}
        <button
          type="button"
          onClick={handleRediscover}
          disabled={rediscovering || saving}
          className={cn(
            "rounded-md bg-secondary px-3 py-1.5 text-sm font-medium text-secondary-foreground hover:opacity-90",
            "disabled:cursor-not-allowed disabled:opacity-50"
          )}
        >
          {rediscovering ? "Rediscovering…" : "Rediscover"}
        </button>

        {/* Cancel + Save — right side */}
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border bg-card px-3 py-1.5 text-sm text-foreground hover:bg-muted"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || rediscovering || !canSave}
            className={cn(
              "rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90",
              "disabled:cursor-not-allowed disabled:opacity-50"
            )}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>
    </form>
  );
}

// ── Modal wrapper ─────────────────────────────────────────────────────────
// Separating the Dialog shell from the form body keeps EdgeForm testable
// without a full DOM environment for the portal.

export type EdgeFormModalProps = {
  edge: Edge;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function EdgeFormModal({ open, onOpenChange, edge }: EdgeFormModalProps) {
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
              Edit edge
            </Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground">
              Update the edge configuration.
            </Dialog.Description>
          </div>

          <div className="px-6 pb-6">
            <EdgeForm
              edge={edge}
              onSuccess={() => onOpenChange(false)}
              onCancel={() => onOpenChange(false)}
            />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
