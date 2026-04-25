"use client";

/**
 * DeviceEditDialog — reclassify a discovered device (#151).
 *
 * Surface contract:
 *   - 640px width, mirroring HouseholdEditDialog (#145).
 *   - Header shows the CURRENT device_type via <StatusChip
 *     kind="deviceType">. Per CLAUDE.md Design System rule 1, never hand-roll
 *     a status chip.
 *   - Body has:
 *       1. `name` text input
 *       2. `device_type` Select (reusing the DEVICE_TYPE_HELP option list
 *          from src/components/DiscoverDevices.tsx)
 *       3. `openems_component_id` rendered read-only (Out of Scope per
 *          AC-3 — identity fields are immutable).
 *   - Save: PATCH /api/devices/[id] with the diff of changed fields only.
 *     Disabled when (a) submitting, (b) name is empty after trim, (c) no
 *     field is dirty vs initial state.
 *   - 409 device_type_role_conflict — surface a destructive ConfirmDialog
 *     ("Unlink household and reclassify") that, on confirm, runs:
 *        1. PATCH /api/households/[id] { device_id: null }  — unlink
 *        2. PATCH /api/devices/[id] { ...same diff }        — reclassify
 *     Two sequential server calls (no transactional combiner) — matches
 *     AC-CASCADE.
 *   - 409 device_type_changed_concurrently — surface a "Device state
 *     changed — refresh and retry" inline error (Banner). Operator hits
 *     refresh.
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Banner } from "@/components/ui/banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusChip } from "@/components/ui/status-chip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DEVICE_TYPE_HELP } from "@/lib/device-type-help";
import { cn } from "@/lib/utils";
import type { DeviceType } from "@/lib/types/domain";

const DEVICE_TYPE_OPTIONS: DeviceType[] = [
  "consumption_meter",
  "grid_meter",
  "pv_meter",
  "battery",
  "inverter",
  "ev_charger",
  "other",
];

// ── Types ────────────────────────────────────────────────────────────────

export type DeviceEditDialogDevice = {
  id: string;
  name: string;
  device_type: DeviceType;
  openems_component_id: string | null;
};

export interface DeviceEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  device: DeviceEditDialogDevice;
}

type FormState = {
  name: string;
  device_type: DeviceType;
};

function initialState(d: DeviceEditDialogDevice): FormState {
  return { name: d.name ?? "", device_type: d.device_type };
}

function isDirty(cur: FormState, init: FormState): boolean {
  return cur.name !== init.name || cur.device_type !== init.device_type;
}

function buildDiff(
  cur: FormState,
  init: FormState
): Partial<{ name: string; device_type: DeviceType }> {
  const out: Partial<{ name: string; device_type: DeviceType }> = {};
  if (cur.name.trim() !== init.name) out.name = cur.name.trim();
  if (cur.device_type !== init.device_type) out.device_type = cur.device_type;
  return out;
}

// ── Component ────────────────────────────────────────────────────────────

export function DeviceEditDialog({
  open,
  onOpenChange,
  device,
}: DeviceEditDialogProps) {
  const router = useRouter();

  const init = React.useMemo(() => initialState(device), [device]);

  const [state, setState] = React.useState<FormState>(init);
  const [submitting, setSubmitting] = React.useState(false);
  const [topError, setTopError] = React.useState<string | null>(null);
  const [confirmCancelOpen, setConfirmCancelOpen] = React.useState(false);
  const [conflictHousehold, setConflictHousehold] = React.useState<{
    id: string;
    display_name: string | null;
  } | null>(null);
  const firstFieldRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setState(init);
      setSubmitting(false);
      setTopError(null);
      setConflictHousehold(null);
    }
  }, [open, init]);

  const dirty = isDirty(state, init);
  const nameValid = state.name.trim().length > 0;
  const canSave = dirty && nameValid && !submitting;

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setState((prev) => ({ ...prev, [key]: value }));
  }

  async function postPatch(
    body: Partial<{ name: string; device_type: DeviceType }>
  ): Promise<Response> {
    return fetch(`/api/devices/${device.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function handleSubmit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSave) return;
    setSubmitting(true);
    setTopError(null);
    setConflictHousehold(null);
    try {
      const res = await postPatch(buildDiff(state, init));
      if (res.ok) {
        router.refresh();
        onOpenChange(false);
        return;
      }
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        reason?: string;
        household?: { id: string; display_name: string | null };
      };
      if (res.status === 409 && body.reason === "device_type_role_conflict") {
        setConflictHousehold(
          body.household ?? { id: "", display_name: null }
        );
        setSubmitting(false);
        return;
      }
      setTopError(body.error ?? `Could not save (HTTP ${res.status}).`);
      setSubmitting(false);
    } catch (err) {
      setTopError(err instanceof Error ? err.message : "Network error.");
      setSubmitting(false);
    }
  }

  // Unlink-and-reclassify: two sequential server calls (no transactional
  // combiner). On any failure, surface inline; the dialog stays open.
  async function handleUnlinkAndReclassify(): Promise<void> {
    if (!conflictHousehold) return;
    // Step 1 — unlink
    const unlinkRes = await fetch(
      `/api/households/${conflictHousehold.id}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: null }),
      }
    );
    if (!unlinkRes.ok) {
      const body = (await unlinkRes.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(
        body.error ?? `Unlink failed (HTTP ${unlinkRes.status}).`
      );
    }
    // Step 2 — reclassify
    const reclassifyRes = await postPatch(buildDiff(state, init));
    if (!reclassifyRes.ok) {
      const body = (await reclassifyRes.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(
        body.error ?? `Reclassify failed (HTTP ${reclassifyRes.status}).`
      );
    }
    router.refresh();
    setConflictHousehold(null);
    onOpenChange(false);
  }

  function requestClose(next: boolean) {
    if (!next && dirty) {
      setConfirmCancelOpen(true);
      return;
    }
    onOpenChange(next);
  }

  return (
    <>
      <Dialog.Root open={open} onOpenChange={requestClose}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
          <Dialog.Content
            aria-modal
            aria-describedby="dev-edit-desc"
            onOpenAutoFocus={(e) => {
              e.preventDefault();
              firstFieldRef.current?.focus();
            }}
            className={cn(
              "fixed left-1/2 top-1/2 z-50 w-[640px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
              "max-h-[92vh] overflow-y-auto rounded-md border border-border bg-card shadow-elev-3 outline-none"
            )}
          >
            {/* top rail */}
            <div aria-hidden="true" className="h-[6px] bg-primary" />

            <div className="px-6 pt-5">
              <Dialog.Title className="text-xl font-semibold tracking-tight text-foreground">
                Edit device
              </Dialog.Title>
              <Dialog.Description
                id="dev-edit-desc"
                className="mt-1 flex items-center gap-2 text-[13px] text-muted-foreground"
              >
                <span>Currently classified as</span>
                <StatusChip kind="deviceType" status={device.device_type} />
              </Dialog.Description>
            </div>

            <form
              onSubmit={handleSubmit}
              className="space-y-5 px-6 pb-2 pt-4"
              noValidate
            >
              {topError && (
                <Banner tone="destructive" title="Could not save">
                  {topError}
                </Banner>
              )}

              {/* NAME */}
              <div>
                <label
                  htmlFor="dev-edit-name"
                  className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Device name
                  <span aria-hidden="true" className="ml-0.5 text-destructive-fg">
                    *
                  </span>
                  <span className="sr-only"> (required)</span>
                </label>
                <Input
                  id="dev-edit-name"
                  ref={firstFieldRef}
                  value={state.name}
                  onChange={(e) => update("name", e.target.value)}
                  required
                  aria-required="true"
                  aria-invalid={nameValid ? undefined : "true"}
                  className={cn(
                    !nameValid && "border-destructive ring-1 ring-destructive"
                  )}
                />
              </div>

              {/* DEVICE TYPE */}
              <div>
                <label
                  htmlFor="dev-edit-type"
                  className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  Device type
                </label>
                <Select
                  value={state.device_type}
                  onValueChange={(val) => update("device_type", val as DeviceType)}
                >
                  <SelectTrigger id="dev-edit-type" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DEVICE_TYPE_OPTIONS.map((dt) => (
                      <SelectItem key={dt} value={dt}>
                        {DEVICE_TYPE_HELP[dt].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="mt-2 text-xs text-muted-foreground">
                  {DEVICE_TYPE_HELP[state.device_type].description}
                </p>
              </div>

              {/* OPENEMS COMPONENT ID — read-only */}
              <div>
                <label
                  htmlFor="dev-edit-component-id"
                  className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground"
                >
                  OpenEMS component ID
                </label>
                <Input
                  id="dev-edit-component-id"
                  value={device.openems_component_id ?? "—"}
                  readOnly
                  disabled
                  className="font-mono"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Identity field — to change, remove the device and re-run Discover.
                </p>
              </div>
            </form>

            <div className="mt-2 flex items-center justify-end gap-2 border-t border-border bg-muted px-6 pb-[18px] pt-[14px]">
              <Dialog.Close asChild>
                <button
                  type="button"
                  disabled={submitting}
                  className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="button"
                onClick={() => handleSubmit()}
                disabled={!canSave}
                className="inline-flex h-8 items-center rounded-md bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {submitting ? "Saving…" : "Save changes"}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Cancel-when-dirty confirm — neutral. */}
      <ConfirmDialog
        open={confirmCancelOpen}
        onOpenChange={setConfirmCancelOpen}
        tone="neutral"
        title="Discard unsaved changes?"
        description="Your edits will be lost."
        confirmLabel="Discard"
        onConfirm={async () => {
          setConfirmCancelOpen(false);
          onOpenChange(false);
        }}
      />

      {/* AC-CASCADE confirm — destructive. Two sequential server calls
          (unlink, then reclassify). */}
      <ConfirmDialog
        open={Boolean(conflictHousehold)}
        onOpenChange={(o) => {
          if (!o) setConflictHousehold(null);
        }}
        tone="destructive"
        title="Unlink household and reclassify?"
        description={
          conflictHousehold
            ? `This device is currently the primary consumption meter for "${
                conflictHousehold.display_name ?? "a household"
              }". Reclassifying will unlink the household — you'll need to assign a new meter before billing the next period.`
            : undefined
        }
        confirmLabel="Unlink and reclassify"
        onConfirm={handleUnlinkAndReclassify}
      />
    </>
  );
}
