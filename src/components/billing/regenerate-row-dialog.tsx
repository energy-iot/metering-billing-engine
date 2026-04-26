"use client";

/**
 * RegenerateRowDialog — per-row regenerate dialog (BC3 #175 AC2).
 *
 * Three sub-paths driven by `mode` + `paymentStatus`:
 *
 *   2a. mode='edge', paymentStatus ∈ {unpaid,failed,link_generated}:
 *       Submits POST /api/billing/generate immediately on mount; dialog body
 *       shows a spinner. Closes the dialog on success and refreshes; on
 *       failure pushes a destructive RowBannerStack entry and closes.
 *
 *   2b. mode='edge', paymentStatus ∈ {paid,refunded}:
 *       Compute-then-confirm. Mounts → fires POST /api/billing/regenerate-preview
 *       → renders the diff in a <ConfirmDialog tone="neutral">. The user
 *       confirms to fire the actual write. The diff includes a closed-period
 *       audit-revision warn-banner when period.status === 'closed' (AC6).
 *
 *   2c. mode='manual':
 *       Inline form with start_kwh / end_kwh / reason. Validation enforced
 *       client-side: both kWh values non-negative finite numbers and
 *       endKwh >= startKwh. POSTs /api/billing/generate with the
 *       manualReadings array on submit.
 *
 * Common plumbing: parent threads `pushBanner` and `dismissBanner` so the
 * dialog can push transient banners via `<RowBannerStack>` from cancel,
 * error, and success paths. Loading + inline-error state lives inside the
 * dialog component.
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Currency } from "@/components/format/currency";
import { Banner } from "@/components/ui/banner";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import type { RowBannerEntry } from "@/components/billing/row-banner-stack";
import type {
  BillingLineItemPaymentStatus,
  BillingPeriodStatus,
} from "@/lib/types/domain";

export type RegenerateRowMode = "edge" | "manual";

export interface RegenerateRowDialogPeriod {
  id: string;
  status: BillingPeriodStatus;
  start_date: string;
  end_date: string;
}

export interface RegenerateRowDialogLineItem {
  id: string;
  payment_status: BillingLineItemPaymentStatus;
}

export interface RegenerateRowDialogHousehold {
  id: string;
  display_name: string;
}

export interface RegenerateRowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: RegenerateRowMode;
  household: RegenerateRowDialogHousehold;
  period: RegenerateRowDialogPeriod;
  lineItem: RegenerateRowDialogLineItem;
  /** Push a transient banner entry into <RowBannerStack>. */
  pushBanner: (entry: RowBannerEntry) => void;
  /** Dismiss a banner entry by id. */
  dismissBanner: (id: string) => void;
  /** Called after a successful regenerate / save so the parent can clear
   *  per-row state (e.g. switchedToManual flag). */
  onSuccess?: (lineItemId: string) => void;
}

type PreviewRow = {
  householdId: string;
  householdName: string;
  startKwh: number;
  endKwh: number;
  usageKwh: number;
  totalAmount: number;
  previousTotalAmount: number | null;
  previousPaymentStatus: BillingLineItemPaymentStatus | null;
};

type PreviewState =
  | { kind: "loading" }
  | { kind: "ready"; preview: PreviewRow }
  | { kind: "error"; message: string };

const ERROR_BANNER_DURATION_MS = 8000;
const INFO_BANNER_DURATION_MS = 4000;

export function RegenerateRowDialog(props: RegenerateRowDialogProps) {
  const { mode, lineItem, open } = props;
  const isPaidPath =
    mode === "edge" &&
    (lineItem.payment_status === "paid" ||
      lineItem.payment_status === "refunded");

  // Three rendering branches, but a single component so the parent's state
  // machine stays simple. Each branch is its own subcomponent below.
  if (!open) return null;

  if (mode === "manual") {
    return <ManualEntryDialog {...props} />;
  }
  if (isPaidPath) {
    return <EdgePaidConfirmDialog {...props} />;
  }
  return <EdgeUnpaidImmediateRunner {...props} />;
}

// ──────────────────────────────────────────────────────────────────────────────
// Edge unpaid path (2a) — fire POST immediately on mount, no UI dialog.
// We render an invisible component because the parent already opened the
// dialog state; we close it ourselves on completion.
// ──────────────────────────────────────────────────────────────────────────────

function EdgeUnpaidImmediateRunner(props: RegenerateRowDialogProps) {
  const {
    onOpenChange,
    household,
    period,
    lineItem,
    pushBanner,
    onSuccess,
  } = props;
  const router = useRouter();
  const firedRef = React.useRef(false);
  // Hold the latest fire function in a ref so the Retry banner action
  // can call back into it without creating a self-referential useCallback
  // (which trips the React Compiler immutability lint).
  const fireRef = React.useRef<() => Promise<void>>(async () => {});

  const fireGenerate = React.useCallback(async () => {
    try {
      const res = await fetch("/api/billing/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billingPeriodId: period.id,
          householdIds: [household.id],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ householdId: string; error: string; code?: string }>;
        error?: string;
      };
      if (!res.ok) {
        pushBanner({
          id: `${lineItem.id}-regen-err-${Date.now()}`,
          lineItemId: lineItem.id,
          tone: "destructive",
          message: body.error ?? "Regenerate failed",
          action: { label: "Retry", onClick: () => void fireRef.current() },
          durationMs: ERROR_BANNER_DURATION_MS,
        });
        onOpenChange(false);
        return;
      }
      if (body.errors && body.errors.length > 0) {
        pushBanner({
          id: `${lineItem.id}-regen-row-err-${Date.now()}`,
          lineItemId: lineItem.id,
          tone: "destructive",
          message: body.errors[0].error || "Regenerate failed",
          action: { label: "Retry", onClick: () => void fireRef.current() },
          durationMs: ERROR_BANNER_DURATION_MS,
        });
        onOpenChange(false);
        return;
      }
      onSuccess?.(lineItem.id);
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      pushBanner({
        id: `${lineItem.id}-regen-net-${Date.now()}`,
        lineItemId: lineItem.id,
        tone: "destructive",
        message:
          err instanceof Error ? err.message : "Network error while regenerating",
        action: { label: "Retry", onClick: () => void fireRef.current() },
        durationMs: ERROR_BANNER_DURATION_MS,
      });
      onOpenChange(false);
    }
  }, [household.id, period.id, lineItem.id, pushBanner, onOpenChange, onSuccess, router]);

  // Keep the ref up-to-date with the latest closure each render.
  React.useEffect(() => {
    fireRef.current = fireGenerate;
  }, [fireGenerate]);

  React.useEffect(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    void fireGenerate();
  }, [fireGenerate]);

  // Render a barebones "Working…" dialog while the request is in flight.
  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
        <Dialog.Content
          role="dialog"
          aria-modal
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "overflow-hidden rounded-md border border-border bg-card shadow-lg outline-none",
          )}
        >
          <div className="px-6 pb-5 pt-5">
            <Dialog.Title className="text-base font-semibold tracking-tight">
              Regenerating bill…
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
              Recomputing readings for {household.display_name}.
            </Dialog.Description>
            <div className="mt-4 inline-block h-4 w-4 animate-spin rounded-full border-2 border-border border-t-transparent" />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Edge paid / refunded path (2b) — compute then confirm.
// ──────────────────────────────────────────────────────────────────────────────

function EdgePaidConfirmDialog(props: RegenerateRowDialogProps) {
  const {
    onOpenChange,
    household,
    period,
    lineItem,
    pushBanner,
    onSuccess,
  } = props;
  const router = useRouter();
  const [state, setState] = React.useState<PreviewState>({ kind: "loading" });
  const fetchedRef = React.useRef(false);

  React.useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;
    void (async () => {
      try {
        const res = await fetch("/api/billing/regenerate-preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            billingPeriodId: period.id,
            householdIds: [household.id],
          }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          preview?: PreviewRow[];
          errors?: Array<{ householdId: string; error: string; code?: string }>;
          error?: string;
        };
        if (!res.ok) {
          pushBanner({
            id: `${lineItem.id}-preview-err-${Date.now()}`,
            lineItemId: lineItem.id,
            tone: "destructive",
            message: body.error ?? "Failed to compute preview",
            durationMs: ERROR_BANNER_DURATION_MS,
          });
          onOpenChange(false);
          return;
        }
        const preview = body.preview ?? [];
        const errors = body.errors ?? [];
        if (preview.length === 0 && errors.length >= 1) {
          // Common case: unmetered_no_manual — surface inline.
          setState({ kind: "error", message: errors[0].error });
          return;
        }
        if (preview.length !== 1) {
          setState({
            kind: "error",
            message: "Preview returned no rows.",
          });
          return;
        }
        setState({ kind: "ready", preview: preview[0] });
      } catch (err) {
        pushBanner({
          id: `${lineItem.id}-preview-net-${Date.now()}`,
          lineItemId: lineItem.id,
          tone: "destructive",
          message:
            err instanceof Error
              ? err.message
              : "Network error while computing preview",
          durationMs: ERROR_BANNER_DURATION_MS,
        });
        onOpenChange(false);
      }
    })();
  }, [household.id, period.id, lineItem.id, pushBanner, onOpenChange]);

  const periodLabel =
    period.start_date === period.end_date
      ? period.start_date
      : `${period.start_date} – ${period.end_date}`;

  const handleConfirm = React.useCallback(async () => {
    const res = await fetch("/api/billing/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billingPeriodId: period.id,
        householdIds: [household.id],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      errors?: Array<{ householdId: string; error: string; code?: string }>;
      error?: string;
    };
    if (!res.ok) {
      throw new Error(body.error ?? "Regenerate failed");
    }
    if (body.errors && body.errors.length > 0) {
      throw new Error(body.errors[0].error || "Regenerate failed");
    }
    onSuccess?.(lineItem.id);
    router.refresh();
  }, [household.id, period.id, lineItem.id, onSuccess, router]);

  // Body content varies by state.
  const previewBody = (() => {
    if (state.kind === "loading") {
      return (
        <div
          data-testid="regenerate-preview-loading"
          className="flex items-center gap-2 py-2 text-[13px] text-muted-foreground"
        >
          <span
            aria-hidden="true"
            className="inline-block h-3 w-3 animate-spin rounded-full border border-border border-t-transparent"
          />
          Computing preview…
        </div>
      );
    }
    if (state.kind === "error") {
      return (
        <div
          data-testid="regenerate-preview-error"
          className="space-y-3"
        >
          {period.status === "closed" && <ClosedPeriodBanner />}
          <p className="text-[13px] text-destructive-fg">{state.message}</p>
        </div>
      );
    }
    const p = state.preview;
    const diff = p.totalAmount - (p.previousTotalAmount ?? 0);
    const pct =
      p.previousTotalAmount && p.previousTotalAmount !== 0
        ? (diff / p.previousTotalAmount) * 100
        : null;
    const sign = diff > 0 ? "+" : "";
    return (
      <div className="space-y-3">
        {period.status === "closed" && <ClosedPeriodBanner />}
        <div className="text-[13px] leading-relaxed text-muted-foreground">
          <span className="font-medium text-foreground">
            {household.display_name}
          </span>{" "}
          · {periodLabel}
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
          <span className="text-muted-foreground">Current total:</span>
          <span className="font-medium text-foreground">
            <Currency value={p.previousTotalAmount ?? 0} />
          </span>
          <span className="text-muted-foreground">New total:</span>
          <span className="font-medium text-foreground">
            <Currency value={p.totalAmount} />
          </span>
          <span className="text-muted-foreground">Difference:</span>
          <span
            className="font-medium text-foreground"
            data-testid="regenerate-preview-diff"
          >
            {sign}
            <Currency value={diff} />
            {pct !== null && (
              <span className="ml-1 text-muted-foreground">
                ({sign}
                {pct.toFixed(1)}%)
              </span>
            )}
          </span>
        </div>
        <p className="text-[12px] text-muted-foreground">
          The bill is currently marked {lineItem.payment_status}. Regenerating
          will recalculate the readings and totals; the payment record (paid_at,
          paid_by_user_id, payment_notes, pesapal_order_id, payment_events
          history) is preserved.
        </p>
      </div>
    );
  })();

  // ConfirmDialog handles its own confirm/cancel flow. We disable confirm
  // when in error state by passing a no-op onConfirm that throws — but
  // cleaner: render a custom Radix dialog only when loading/error and the
  // ConfirmDialog only when ready. The parent expects a single dialog
  // instance, so we always render the ConfirmDialog and override the body.

  // When in loading or error state, we pass an onConfirm that immediately
  // throws so the user can't accidentally fire a regenerate without a valid
  // preview. The user-visible state is the body itself.
  const onConfirmFn =
    state.kind === "ready"
      ? handleConfirm
      : async () => {
          throw new Error(
            state.kind === "error" ? state.message : "Preview not ready yet",
          );
        };

  return (
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Regenerate this bill?"
      tone="neutral"
      confirmLabel="Regenerate"
      onConfirm={onConfirmFn}
      body={previewBody}
    />
  );
}

function ClosedPeriodBanner() {
  return (
    <Banner tone="warn" title="Period is closed">
      Regenerating will write an audit-log revision; the period status stays
      closed.
    </Banner>
  );
}

// ──────────────────────────────────────────────────────────────────────────────
// Manual entry / re-entry path (2c) — start_kwh / end_kwh / reason form.
// ──────────────────────────────────────────────────────────────────────────────

function ManualEntryDialog(props: RegenerateRowDialogProps) {
  const {
    onOpenChange,
    household,
    period,
    lineItem,
    pushBanner,
    onSuccess,
  } = props;
  const router = useRouter();
  const [startKwh, setStartKwh] = React.useState("");
  const [endKwh, setEndKwh] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const startInputRef = React.useRef<HTMLInputElement>(null);
  const startId = React.useId();
  const endId = React.useId();
  const reasonId = React.useId();

  React.useEffect(() => {
    // Focus the first field on open.
    queueMicrotask(() => startInputRef.current?.focus());
  }, []);

  function parseField(raw: string): { ok: true; value: number } | { ok: false; reason: string } {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { ok: false, reason: "Required" };
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { ok: false, reason: "Must be a number" };
    if (n < 0) return { ok: false, reason: "Must be a non-negative number" };
    return { ok: true, value: n };
  }

  const startParsed = parseField(startKwh);
  const endParsed = parseField(endKwh);
  const startError = startKwh.length > 0 && !startParsed.ok ? startParsed.reason : null;
  const endError = endKwh.length > 0 && !endParsed.ok ? endParsed.reason : null;
  const orderError =
    startParsed.ok && endParsed.ok && endParsed.value < startParsed.value
      ? "End must be ≥ Start"
      : null;
  const canSubmit =
    startParsed.ok && endParsed.ok && !orderError && !submitting;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit || !startParsed.ok || !endParsed.ok) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      const res = await fetch("/api/billing/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          billingPeriodId: period.id,
          householdIds: [household.id],
          manualReadings: [
            {
              householdId: household.id,
              startKwh: startParsed.value,
              endKwh: endParsed.value,
              ...(reason.trim() ? { reason: reason.trim() } : {}),
            },
          ],
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        errors?: Array<{ householdId: string; error: string; code?: string }>;
        error?: string;
      };
      if (!res.ok) {
        setErrorMsg(body.error ?? "Save failed");
        setSubmitting(false);
        return;
      }
      if (body.errors && body.errors.length > 0) {
        setErrorMsg(body.errors[0].error || "Save failed");
        setSubmitting(false);
        return;
      }
      onSuccess?.(lineItem.id);
      pushBanner({
        id: `${lineItem.id}-manual-saved-${Date.now()}`,
        lineItemId: lineItem.id,
        tone: "info",
        message: "Manual reading saved.",
        durationMs: INFO_BANNER_DURATION_MS,
      });
      onOpenChange(false);
      router.refresh();
    } catch (err) {
      setErrorMsg(
        err instanceof Error ? err.message : "Network error",
      );
      setSubmitting(false);
    }
  }

  const periodLabel =
    period.start_date === period.end_date
      ? period.start_date
      : `${period.start_date} – ${period.end_date}`;

  return (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
        <Dialog.Content
          role="dialog"
          aria-modal
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "overflow-hidden rounded-md border border-border bg-card shadow-lg outline-none",
          )}
          onEscapeKeyDown={() => onOpenChange(false)}
        >
          <div className="h-[6px] bg-primary" aria-hidden="true" />
          <form onSubmit={handleSubmit}>
            <div className="px-6 pb-2 pt-5">
              <Dialog.Title className="text-xl font-semibold tracking-tight">
                Manual readings
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {household.display_name}
                </span>{" "}
                · {periodLabel}
              </Dialog.Description>
            </div>

            {period.status === "closed" && (
              <div className="px-6 pt-2">
                <ClosedPeriodBanner />
              </div>
            )}

            <div className="space-y-3 px-6 pb-1 pt-3">
              <div>
                <label
                  htmlFor={startId}
                  className="mb-1 block text-[12px] font-medium text-foreground"
                >
                  Start (kWh)
                </label>
                <input
                  ref={startInputRef}
                  id={startId}
                  type="number"
                  step="0.001"
                  min="0"
                  inputMode="decimal"
                  value={startKwh}
                  onChange={(e) => setStartKwh(e.target.value)}
                  aria-invalid={startError !== null}
                  aria-describedby={startError ? `${startId}-err` : undefined}
                  className="block w-full rounded-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {startError && (
                  <p
                    id={`${startId}-err`}
                    className="mt-1 text-[11px] text-destructive-fg"
                  >
                    {startError}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor={endId}
                  className="mb-1 block text-[12px] font-medium text-foreground"
                >
                  End (kWh)
                </label>
                <input
                  id={endId}
                  type="number"
                  step="0.001"
                  min="0"
                  inputMode="decimal"
                  value={endKwh}
                  onChange={(e) => setEndKwh(e.target.value)}
                  aria-invalid={endError !== null || orderError !== null}
                  aria-describedby={
                    endError || orderError ? `${endId}-err` : undefined
                  }
                  className="block w-full rounded-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                {(endError || orderError) && (
                  <p
                    id={`${endId}-err`}
                    className="mt-1 text-[11px] text-destructive-fg"
                  >
                    {endError ?? orderError}
                  </p>
                )}
              </div>
              <div>
                <label
                  htmlFor={reasonId}
                  className="mb-1 block text-[12px] font-medium text-foreground"
                >
                  Reason for manual entry{" "}
                  <span className="font-normal text-muted-foreground">
                    (optional)
                  </span>
                </label>
                <textarea
                  id={reasonId}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  rows={2}
                  aria-label="Manual entry reason (optional, max 500 characters)"
                  className="block w-full resize-none rounded-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <p className="mt-0.5 text-right text-[11px] text-muted-foreground">
                  {reason.length}/500
                </p>
              </div>
            </div>

            {errorMsg && (
              <div className="px-6 pt-2">
                <div className="rounded-md bg-destructive-muted px-3 py-2.5 text-[13px] text-destructive-fg">
                  {errorMsg}
                </div>
              </div>
            )}

            <div className="mt-4 flex items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px]">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={!canSubmit}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
              >
                {submitting && (
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
                )}
                Save manual reading
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
