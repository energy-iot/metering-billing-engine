"use client";

/**
 * AddEdgeDialog — Discover-driven multi-select Add Edge flow (#103).
 *
 * Replaces the disabled `+ Add edge` stub in EdgesCRUDShell. On open, fires
 * POST /api/microgrids/[id]/openems-backend/discover, then renders the
 * returned edges in a checkbox list. On submit, POSTs the selected (non-
 * already-linked) edges to /api/microgrids/[id]/edges/register.
 *
 * 5-state machine:
 *   • discovering — spinner + muted copy; Cancel enabled; primary disabled.
 *   • list        — scrollable checkbox rows; footer [Add selected (N)].
 *   • empty       — centered muted copy; footer becomes [Close].
 *   • error       — destructive block inside body with [Retry]; primary disabled.
 *   • adding      — dialog locked (Esc/backdrop suppressed); primary shows
 *                   spinner + "Adding…"; checkboxes + Cancel disabled.
 *
 * On register success: dialog closes; router.refresh() repaints the listing.
 * On register error: stays open, shows inline destructive banner above the
 * footer, re-enables inputs for retry.
 *
 * Role is deliberately NOT sent — the register route defaults it to NULL.
 * User sets role later via Edit Edge (#104).
 *
 * See issue #103 "Pinned during refinement" for the full contract.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { SelectionDialog } from "@/components/ui/selection-dialog";
import { StatusChip } from "@/components/ui/status-chip";
import { Chip } from "@/components/ui/chip";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────

type DiscoveredEdge = {
  openems_edge_id: string;
  name: string;
  /** Per Discover route response shape (#101). */
  metadata: { online?: boolean } & Record<string, unknown>;
  alreadyLinked: boolean;
};

type DiscoverResponse = {
  status:
    | "success"
    | "auth_failed"
    | "unreachable"
    | "zero_edges"
    | "unknown_error";
  message?: string;
  error?: string;
  edges?: DiscoveredEdge[];
};

type DialogState =
  | { kind: "discovering" }
  | { kind: "list"; edges: DiscoveredEdge[] }
  | { kind: "empty"; message: string }
  | { kind: "error"; message: string }
  | { kind: "adding"; edges: DiscoveredEdge[] };

export interface AddEdgeDialogProps {
  microgridId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// ── Component ────────────────────────────────────────────────────────────

export function AddEdgeDialog({
  microgridId,
  open,
  onOpenChange,
}: AddEdgeDialogProps) {
  const router = useRouter();
  const [state, setState] = React.useState<DialogState>({ kind: "discovering" });
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [registerError, setRegisterError] = React.useState<string | null>(null);

  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const primaryRef = React.useRef<HTMLButtonElement>(null);
  const retryRef = React.useRef<HTMLButtonElement>(null);
  const firstNewCheckboxRef = React.useRef<HTMLInputElement>(null);

  // ── Discover ──────────────────────────────────────────────────────────
  const runDiscover = React.useCallback(async () => {
    setState({ kind: "discovering" });
    setRegisterError(null);
    try {
      const res = await fetch(
        `/api/microgrids/${microgridId}/openems-backend/discover`,
        { method: "POST" },
      );
      let body: DiscoverResponse | null = null;
      try {
        body = (await res.json()) as DiscoverResponse;
      } catch {
        body = null;
      }

      if (!res.ok) {
        const msg =
          body?.error || body?.message || "Discover failed. Please retry.";
        setState({ kind: "error", message: msg });
        return;
      }

      if (!body) {
        setState({ kind: "error", message: "Discover failed. Please retry." });
        return;
      }

      if (body.status === "success" && (body.edges?.length ?? 0) > 0) {
        // Pre-select already-linked rows so they show as "included" visually,
        // even though we strip them from the submit payload.
        const preSelected = new Set<string>();
        for (const e of body.edges ?? []) {
          if (e.alreadyLinked) preSelected.add(e.openems_edge_id);
        }
        setSelected(preSelected);
        setState({ kind: "list", edges: body.edges ?? [] });
        return;
      }

      if (body.status === "zero_edges") {
        setState({
          kind: "empty",
          message:
            body.message ||
            "Connected, but no edges are registered on this backend yet. Register an edge in OpenEMS, then return here.",
        });
        return;
      }

      if (
        body.status === "auth_failed" ||
        body.status === "unreachable" ||
        body.status === "unknown_error"
      ) {
        setState({
          kind: "error",
          message:
            body.message || body.error || "Discover failed. Please retry.",
        });
        return;
      }

      // Fallback (e.g. success with zero edges, or unknown body shape).
      setState({
        kind: "empty",
        message:
          body.message ||
          "Connected, but no edges are registered on this backend yet. Register an edge in OpenEMS, then return here.",
      });
    } catch {
      setState({ kind: "error", message: "Discover failed. Please retry." });
    }
  }, [microgridId]);

  // Fire Discover whenever the dialog opens. Reset state + selection on close.
  React.useEffect(() => {
    if (open) {
      runDiscover();
    } else {
      setSelected(new Set());
      setRegisterError(null);
      setState({ kind: "discovering" });
    }
  }, [open, runDiscover]);

  // ── Focus management ─────────────────────────────────────────────────
  // Focus target per AC-A11Y-FOCUS:
  //   discovering → Cancel
  //   list        → first selectable (non-already-linked) checkbox
  //   empty       → Close (rendered in primary slot)
  //   error       → Retry button
  //   adding      → primary button
  React.useEffect(() => {
    if (!open) return;
    // Defer one tick so Radix's own onOpenAutoFocus has already run.
    const id = window.setTimeout(() => {
      if (state.kind === "discovering") {
        cancelRef.current?.focus();
      } else if (state.kind === "list") {
        firstNewCheckboxRef.current?.focus();
      } else if (state.kind === "empty") {
        primaryRef.current?.focus();
      } else if (state.kind === "error") {
        retryRef.current?.focus();
      } else if (state.kind === "adding") {
        primaryRef.current?.focus();
      }
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, state.kind]);

  // ── Derived selection state ──────────────────────────────────────────
  const edges = React.useMemo<DiscoveredEdge[]>(() => {
    if (state.kind === "list" || state.kind === "adding") return state.edges;
    return [];
  }, [state]);

  const newEdges = React.useMemo(
    () => edges.filter((e) => !e.alreadyLinked),
    [edges],
  );

  const newSelectedIds = React.useMemo(
    () =>
      newEdges.filter((e) => selected.has(e.openems_edge_id)).map(
        (e) => e.openems_edge_id,
      ),
    [newEdges, selected],
  );

  const allNewSelected =
    newEdges.length > 0 && newSelectedIds.length === newEdges.length;

  // ── Handlers ─────────────────────────────────────────────────────────
  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllNew() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allNewSelected) {
        for (const e of newEdges) next.delete(e.openems_edge_id);
      } else {
        for (const e of newEdges) next.add(e.openems_edge_id);
      }
      return next;
    });
  }

  async function handleAdd() {
    if (state.kind !== "list") return;
    const payload = newEdges
      .filter((e) => selected.has(e.openems_edge_id))
      .map((e) => ({
        openems_edge_id: e.openems_edge_id,
        name: e.name,
      }));
    if (payload.length === 0) return;

    setRegisterError(null);
    setState({ kind: "adding", edges: state.edges });

    try {
      const res = await fetch(
        `/api/microgrids/${microgridId}/edges/register`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ edges: payload }),
        },
      );
      if (!res.ok) {
        let message = "Registration failed. Please retry.";
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = body.error;
        } catch {
          // keep fallback
        }
        // Back to list state, surface error banner above footer.
        setState({ kind: "list", edges });
        setRegisterError(message);
        return;
      }
      // Success — close + refresh.
      onOpenChange(false);
      router.refresh();
    } catch {
      setState({ kind: "list", edges });
      setRegisterError("Registration failed. Please retry.");
    }
  }

  // ── Render ───────────────────────────────────────────────────────────
  const adding = state.kind === "adding";
  const newSelectedCount = newSelectedIds.length;

  const body = (
    <>
      {state.kind === "discovering" && (
        <div className="flex h-[240px] items-center justify-center">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner />
            Discovering edges on this backend…
          </div>
        </div>
      )}

      {state.kind === "empty" && (
        <div className="flex h-[240px] items-center justify-center px-6 text-center">
          <p className="text-sm text-muted-foreground">{state.message}</p>
        </div>
      )}

      {state.kind === "error" && (
        <div className="py-6">
          <div
            role="alert"
            className="rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg"
          >
            {state.message}
          </div>
          <div className="mt-3 flex justify-end">
            <button
              ref={retryRef}
              type="button"
              onClick={runDiscover}
              className="inline-flex h-8 items-center rounded-md border border-border bg-card px-3.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {(state.kind === "list" || state.kind === "adding") && (
        <div>
          <div className="flex items-center justify-between py-2">
            <p className="text-[12px] text-muted-foreground">
              {edges.length} edge{edges.length === 1 ? "" : "s"} found
            </p>
            {newEdges.length > 0 && (
              <button
                type="button"
                onClick={toggleAllNew}
                disabled={adding}
                className="text-[12px] font-medium text-primary hover:underline disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
              >
                {allNewSelected ? "Deselect all new" : "Select all new"}
              </button>
            )}
          </div>
          <ul className="divide-y divide-border">
            {edges.map((edge, idx) => {
              const isFirstNew =
                !edge.alreadyLinked &&
                edges.findIndex((e) => !e.alreadyLinked) === idx;
              const online = edge.metadata?.online === true;
              const isChecked = selected.has(edge.openems_edge_id);
              const idRowDescId = `edge-row-id-${edge.openems_edge_id}`;
              return (
                <li
                  key={edge.openems_edge_id}
                  className={cn(
                    "border-b border-border last:border-b-0",
                    edge.alreadyLinked && "opacity-70",
                  )}
                >
                  <label
                    className={cn(
                      "flex items-start gap-3 px-2 py-3 hover:bg-muted",
                      edge.alreadyLinked
                        ? "cursor-not-allowed"
                        : "cursor-pointer",
                    )}
                    title={
                      edge.alreadyLinked
                        ? "Already registered in this microgrid"
                        : undefined
                    }
                  >
                    <input
                      ref={isFirstNew ? firstNewCheckboxRef : undefined}
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
                      checked={edge.alreadyLinked ? true : isChecked}
                      disabled={edge.alreadyLinked || adding}
                      aria-disabled={edge.alreadyLinked ? "true" : undefined}
                      aria-describedby={idRowDescId}
                      onChange={() => toggleOne(edge.openems_edge_id)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {edge.name}
                        </span>
                        <StatusChip
                          kind="edge"
                          status={online ? "online" : "offline"}
                        />
                        {edge.alreadyLinked && (
                          <Chip
                            tone="neutral"
                            aria-label="Already linked to this microgrid"
                          >
                            Already linked
                          </Chip>
                        )}
                      </div>
                      <p
                        id={idRowDescId}
                        className="mt-0.5 font-mono text-xs text-muted-foreground"
                      >
                        {edge.openems_edge_id}
                      </p>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>

          {registerError && (
            <div
              role="alert"
              className="mt-3 rounded-md bg-destructive-muted p-3 text-sm text-destructive-fg"
            >
              {registerError}
            </div>
          )}
        </div>
      )}
    </>
  );

  // ── Footer ───────────────────────────────────────────────────────────
  let footer: React.ReactNode = null;

  if (state.kind === "empty") {
    footer = (
      <button
        ref={primaryRef}
        type="button"
        onClick={() => onOpenChange(false)}
        className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Close
      </button>
    );
  } else if (state.kind === "error") {
    footer = (
      <button
        ref={cancelRef}
        type="button"
        onClick={() => onOpenChange(false)}
        className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Cancel
      </button>
    );
  } else {
    // discovering / list / adding
    const primaryDisabled =
      state.kind === "discovering" || newSelectedCount === 0 || adding;
    footer = (
      <>
        <button
          ref={cancelRef}
          type="button"
          onClick={() => onOpenChange(false)}
          disabled={adding}
          className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          ref={primaryRef}
          type="button"
          onClick={handleAdd}
          disabled={primaryDisabled}
          className="inline-flex h-8 items-center gap-2 rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {adding && <Spinner />}
          {adding ? "Adding…" : `Add selected (${newSelectedCount})`}
        </button>
      </>
    );
  }

  return (
    <SelectionDialog
      open={open}
      onOpenChange={(next) => {
        if (!next && adding) return; // suppressed while submitting
        onOpenChange(next);
      }}
      title="Add edges from OpenEMS"
      locked={adding}
      onOpenAutoFocus={(e) => {
        // Prevent Radix default focus; the focus effect above handles it.
        e.preventDefault();
      }}
      footer={footer}
    >
      {body}
    </SelectionDialog>
  );
}

// ── Spinner ──────────────────────────────────────────────────────────────

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5 animate-spin"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
    >
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
