"use client";

/**
 * EdgeForm — Add / Edit an Edge.
 *
 * Modal via Radix Dialog. Fields: name, data_source_type (RadioCard tiles),
 * conditional OpenEMS fields (openems_backend_url, openems_edge_id), role.
 *
 * Props:
 *   mode='create'  → requires parentMicrogridId
 *   mode='edit'    → requires edge (the full Edge row to pre-fill)
 *
 * Posts to /api/edges (POST) or /api/edges/[id] (PATCH).
 * Never writes to Supabase directly from the browser.
 *
 * Error surface: <Banner> at top for server errors (403/409/422);
 * field-level "required" state handled by disabled Save button.
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { RadioGroup } from "@/components/ui/radio-group";
import { RadioCard } from "@/components/ui/radio-card";
import { Banner } from "@/components/ui/banner";
import type { Database } from "@/lib/types/database.gen";
import type { Edge } from "@/lib/types/domain";

// ── Enum-derived options ──────────────────────────────────────────────────
// Pull the union type from the generated DB types so there's no hardcoded string union.
type EdgeDataSource = Database["public"]["Enums"]["edge_data_source"];

// Runtime array — keeps the order and descriptions in one place.
// The type annotation ensures no string outside the enum slips in.
const DATA_SOURCE_OPTIONS: Array<{
  value: EdgeDataSource;
  title: string;
  description: string;
}> = [
  {
    value: "openems",
    title: "OpenEMS",
    description:
      "Connect via the OpenEMS Backend WebSocket. Requires backend URL and edge ID.",
  },
  {
    value: "modbus_direct",
    title: "Modbus Direct",
    description:
      "Poll meters directly over Modbus TCP/RTU. Useful for CHINT meters and similar.",
  },
  {
    value: "mqtt",
    title: "MQTT",
    description:
      "Subscribe to meter telemetry published on an MQTT broker.",
  },
  {
    value: "rest_api",
    title: "REST API",
    description:
      "Pull readings from a custom HTTP/REST endpoint.",
  },
];

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

export function EdgeForm({ mode, edge, parentMicrogridId, onSuccess, onCancel }: EdgeFormProps) {
  const router = useRouter();

  // Form state
  const [name, setName] = React.useState(mode === "edit" ? (edge.name ?? "") : "");
  const [dataSourceType, setDataSourceType] = React.useState<EdgeDataSource>(
    mode === "edit" ? edge.data_source_type : "openems"
  );
  const [openemsBackendUrl, setOpenemsBackendUrl] = React.useState(
    mode === "edit" && edge.data_source_type === "openems"
      ? (edge.openems_backend_url ?? "")
      : ""
  );
  const [openemsEdgeId, setOpenemsEdgeId] = React.useState(
    mode === "edit" && edge.data_source_type === "openems"
      ? (edge.openems_edge_id ?? "")
      : ""
  );
  const [role, setRole] = React.useState(mode === "edit" ? (edge.role ?? "") : "");

  // UI state
  const [saving, setSaving] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const isOpenEms = dataSourceType === "openems";

  // When data_source_type changes away from openems, clear OpenEMS fields.
  function handleDataSourceChange(next: string) {
    const value = next as EdgeDataSource;
    setDataSourceType(value);
    if (value !== "openems") {
      setOpenemsBackendUrl("");
      setOpenemsEdgeId("");
    }
    // Clear field-level errors for the OpenEMS fields when toggling away.
    setFieldErrors((prev) => {
      const updated = { ...prev };
      delete updated.openems_backend_url;
      delete updated.openems_edge_id;
      return updated;
    });
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    setFieldErrors({});

    // Client-side field validation before network call.
    const errors: Record<string, string> = {};
    if (!name.trim()) errors.name = "Name is required.";
    if (isOpenEms) {
      if (!openemsBackendUrl.trim()) {
        errors.openems_backend_url = "Backend URL is required for OpenEMS edges.";
      }
      if (!openemsEdgeId.trim()) {
        errors.openems_edge_id = "Edge ID is required for OpenEMS edges.";
      }
    }
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    const body: Record<string, unknown> = {
      name: name.trim(),
      data_source_type: dataSourceType,
      role: role.trim() || null,
    };

    if (isOpenEms) {
      body.openems_backend_url = openemsBackendUrl.trim();
      body.openems_edge_id = openemsEdgeId.trim();
    } else {
      body.openems_backend_url = null;
      body.openems_edge_id = null;
    }

    if (mode === "create") {
      body.microgrid_id = parentMicrogridId;
    }

    const url = mode === "create" ? "/api/edges" : `/api/edges/${edge.id}`;
    const method = mode === "create" ? "POST" : "PATCH";

    setSaving(true);
    try {
      const res = await fetch(url, {
        method,
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

  const canSave =
    name.trim().length > 0 &&
    (!isOpenEms || (openemsBackendUrl.trim().length > 0 && openemsEdgeId.trim().length > 0));

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

      {/* Data source type */}
      <div>
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Data source type <span aria-hidden="true">*</span>
        </p>
        <RadioGroup
          value={dataSourceType}
          onValueChange={handleDataSourceChange}
          className="grid grid-cols-1 gap-2 sm:grid-cols-2"
          aria-label="Data source type"
        >
          {DATA_SOURCE_OPTIONS.map((opt) => (
            <RadioCard
              key={opt.value}
              value={opt.value}
              title={opt.title}
              description={opt.description}
            />
          ))}
        </RadioGroup>
      </div>

      {/* Conditional OpenEMS fields — rendered only when data_source_type='openems' */}
      {isOpenEms && (
        <div className="space-y-3 rounded-md border border-border bg-muted p-4">
          <p className="text-xs text-muted-foreground">
            Find these in the OpenEMS Backend admin UI under Edges.
          </p>

          {/* OpenEMS Backend URL */}
          <div>
            <label
              htmlFor="edge-openems-url"
              className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
            >
              OpenEMS Backend URL <span aria-hidden="true">*</span>
            </label>
            <Input
              id="edge-openems-url"
              type="url"
              value={openemsBackendUrl}
              onChange={(e) => setOpenemsBackendUrl(e.target.value)}
              placeholder="https://openems.example.com"
              required
              aria-required="true"
              aria-describedby={
                fieldErrors.openems_backend_url ? "edge-openems-url-error" : undefined
              }
            />
            {fieldErrors.openems_backend_url && (
              <p
                id="edge-openems-url-error"
                role="alert"
                className="mt-1 text-xs text-destructive-fg"
              >
                {fieldErrors.openems_backend_url}
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
        </div>
      )}

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
      ? "Register a new gateway device for this microgrid."
      : "Update the edge configuration. Changing the data source type is blocked when devices are linked.";

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
