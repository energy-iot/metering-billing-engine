"use client";

/**
 * RegenerateMultiDialog — multi-select bulk regenerate (BC3 #175 AC4).
 *
 * Triggered by the sticky selection bar's "Regenerate selected" button.
 * Displays the selected households grouped into:
 *   - "Will be regenerated" (current reading_source = 'edge'),
 *   - "Will be skipped" (current reading_source = 'manual') — Q5=B: manual
 *     rows are per-row only inside this multi-flow.
 *
 * On confirm: single POST /api/billing/generate with the edge-only set as
 * householdIds (NO manualReadings). Renders inline destructive banner on
 * non-2xx OR if errors[] is non-empty (top-level + per-row banners pushed
 * via parent callbacks).
 *
 * View-state machine (BC3 polish #182):
 *   - `view === 'form'` → render <ConfirmDialog> (existing happy path).
 *   - `view === 'result'` → render a parallel Radix <Dialog.Root> with an
 *     inline banner + "Close" button. Switched into when the response has
 *     errors.length > 0 (partial OR full failure). <ConfirmDialog>'s footer
 *     cannot host a "Close-only" view, so we render a sibling dialog instead
 *     (precedent: ManualEntryDialog in regenerate-row-dialog.tsx:564-723).
 */

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { Banner } from "@/components/ui/banner";
import { Currency } from "@/components/format/currency";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { StatusChip } from "@/components/ui/status-chip";
import {
  errorCodeCopy,
  type PartialFailureError,
} from "@/components/billing/error-code-copy";
import type { RowBannerEntry } from "@/components/billing/row-banner-stack";
import type {
  BillingLineItem,
  Household,
  ReadingSource,
} from "@/lib/types/domain";

export type ParentBannerTone = "info" | "destructive";

export interface ParentBannerInput {
  tone: ParentBannerTone;
  message: string;
  action?: { label: string; onClick: () => void };
  durationMs: number;
}

export interface RegenerateMultiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  billingPeriodId: string;
  /** Selected household IDs (parent owns the Set). */
  selectedHouseholdIds: string[];
  /** Households indexed by id. */
  households: Household[];
  /** Line items for the current period, indexed by household_id. */
  lineItemsByHouseholdId: Map<string, BillingLineItem>;
  /** Push a parent-level banner (sibling of paidToasts). */
  pushParentBanner: (entry: ParentBannerInput) => void;
  /** Push a per-row destructive banner via <RowBannerStack>. */
  pushRowBanner: (entry: RowBannerEntry) => void;
  /** Called after a successful regenerate so the parent can clear the selection set. */
  onSuccess?: () => void;
}

const ERROR_BANNER_DURATION_MS = 8000;
const INFO_BANNER_DURATION_MS = 5000;
const MAX_FAILURES_INLINE = 5;

interface ResultState {
  errors: PartialFailureError[];
  successCount: number;
  attemptedCount: number;
}

export function RegenerateMultiDialog(props: RegenerateMultiDialogProps) {
  const {
    open,
    onOpenChange,
    billingPeriodId,
    selectedHouseholdIds,
    households,
    lineItemsByHouseholdId,
    pushParentBanner,
    pushRowBanner,
    onSuccess,
  } = props;
  const router = useRouter();

  // View-state: 'form' shows the <ConfirmDialog>; 'result' shows a parallel
  // Radix Dialog with a banner + Close button. The form view auto-closes on
  // all-success; the result view is shown only when errors.length > 0.
  const [view, setView] = React.useState<"form" | "result">("form");
  const [result, setResult] = React.useState<ResultState | null>(null);

  // Reset view-state whenever the dialog re-opens.
  React.useEffect(() => {
    if (open) {
      setView("form");
      setResult(null);
    }
  }, [open]);

  // Build the partition — pure derivation from props.
  type Row = {
    householdId: string;
    householdName: string;
    lineItemId: string | null;
    readingSource: ReadingSource | null;
    totalAmount: number | null;
  };

  const householdsById = React.useMemo(() => {
    const m = new Map<string, Household>();
    for (const h of households) m.set(h.id, h);
    return m;
  }, [households]);

  const rows: Row[] = selectedHouseholdIds.map((hid) => {
    const h = householdsById.get(hid);
    const li = lineItemsByHouseholdId.get(hid) ?? null;
    return {
      householdId: hid,
      householdName: h?.display_name ?? "Unknown",
      lineItemId: li?.id ?? null,
      readingSource: li?.reading_source ?? null,
      totalAmount: li?.total_amount ?? null,
    };
  });

  const edgeRows = rows.filter((r) => r.readingSource !== "manual");
  const manualRows = rows.filter((r) => r.readingSource === "manual");
  const allSelectedAreManual = rows.length > 0 && edgeRows.length === 0;

  // Hold the latest values in a ref so the confirm handler can read them
  // without manual memoization (React Compiler handles its own caching;
  // a useCallback whose deps include derived arrays cannot be preserved).
  const stateRef = React.useRef({
    edgeIds: edgeRows.map((r) => r.householdId),
    billingPeriodId,
    pushParentBanner,
    pushRowBanner,
    lineItemsByHouseholdId,
    onSuccess,
    router,
  });
  React.useEffect(() => {
    stateRef.current = {
      edgeIds: edgeRows.map((r) => r.householdId),
      billingPeriodId,
      pushParentBanner,
      pushRowBanner,
      lineItemsByHouseholdId,
      onSuccess,
      router,
    };
  });

  async function handleConfirm() {
    const s = stateRef.current;
    if (s.edgeIds.length === 0) {
      throw new Error("All selected rows are manual — nothing to regenerate.");
    }
    const res = await fetch("/api/billing/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        billingPeriodId: s.billingPeriodId,
        householdIds: s.edgeIds,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      lineItems?: number;
      errors?: Array<{
        householdId: string;
        householdName: string;
        error: string;
        code?: string;
      }>;
      error?: string;
    };
    if (!res.ok) {
      // Top-level failure — surface a parent-level destructive banner.
      const message = body.error ?? "Failed to regenerate";
      s.pushParentBanner({
        tone: "destructive",
        message,
        durationMs: ERROR_BANNER_DURATION_MS,
      });
      throw new Error(message);
    }

    const respErrors = body.errors ?? [];
    // Push per-row destructive banners for failures (preserved per AC4).
    const stamp = Date.now();
    for (const err of respErrors) {
      const li = s.lineItemsByHouseholdId.get(err.householdId);
      if (!li) continue;
      s.pushRowBanner({
        id: `${li.id}-multi-regen-err-${stamp}-${err.householdId}`,
        lineItemId: li.id,
        tone: "destructive",
        message: err.error,
        durationMs: ERROR_BANNER_DURATION_MS,
      });
    }

    // Success info banner — N is the number of edge-only-selected rows
    // minus rows that came back as errors.
    const successCount = s.edgeIds.length - respErrors.length;
    if (successCount > 0) {
      s.pushParentBanner({
        tone: "info",
        message: `Regenerated ${successCount} household${successCount === 1 ? "" : "s"}`,
        durationMs: INFO_BANNER_DURATION_MS,
      });
    }

    // Always refresh so partial successes appear on the next render.
    s.router.refresh();

    if (respErrors.length > 0) {
      // Partial OR full failure — switch to result view (keeps dialog open).
      // For full failure: leave the selection set intact so the user can
      // retry from the sticky bar (do NOT call onSuccess).
      // For partial failure: call onSuccess so the parent clears the
      // selection set — partial successes are persisted on the server, and
      // re-running the regenerate would no-op for them (or churn audit).
      if (successCount > 0) {
        s.onSuccess?.();
      }
      setResult({
        errors: respErrors,
        successCount,
        attemptedCount: s.edgeIds.length,
      });
      setView("result");
      // <ConfirmDialog>.handleConfirm calls onOpenChange(false) on a
      // resolved promise — that would close the wrapper dialog out from
      // under our result view. Throw to take the catch branch instead;
      // the next render swaps to <ResultDialog> (view === 'result'), so
      // the ConfirmDialog unmounts before its own error footer can show
      // the marker message.
      throw new Error("__partial_failure__");
    }

    // All-success path — auto-close + caller's onSuccess.
    s.onSuccess?.();
  }

  const confirmLabel = `Regenerate ${edgeRows.length} household${edgeRows.length === 1 ? "" : "s"}`;

  const onConfirmHandler = allSelectedAreManual
    ? async () => {
        throw new Error(
          "All selected rows are manual — nothing to regenerate.",
        );
      }
    : handleConfirm;

  // Result-view content (rendered when view === 'result').
  // Always render the parent <Dialog.Root> conditionally so we never have
  // both dialogs mounted at the same time.
  if (view === "result" && result) {
    return (
      <ResultDialog
        open={open}
        onOpenChange={onOpenChange}
        result={result}
      />
    );
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Regenerate selected bills?"
      tone="neutral"
      confirmLabel={
        allSelectedAreManual
          ? "Regenerate"
          : confirmLabel
      }
      onConfirm={onConfirmHandler}
      body={
        <div className="space-y-3">
          {edgeRows.length > 0 && (
            <section data-testid="regen-multi-edge-section">
              <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Will be regenerated ({edgeRows.length})
              </h4>
              <ul className="space-y-1">
                {edgeRows.map((r) => (
                  <li
                    key={r.householdId}
                    className="flex items-center justify-between gap-2 text-[13px]"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {r.householdName}
                      </span>
                      {r.readingSource && (
                        <StatusChip
                          kind="billingLineItemReadingSource"
                          status={r.readingSource}
                        />
                      )}
                    </span>
                    {r.totalAmount != null && (
                      <span className="text-muted-foreground">
                        <Currency value={r.totalAmount} bareNumber />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {manualRows.length > 0 && (
            <section data-testid="regen-multi-skip-section">
              <h4 className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                Will be skipped ({manualRows.length})
              </h4>
              <p className="mb-1 text-[12px] text-muted-foreground">
                Manual readings are per-row only — close this and use the row
                menu to regenerate.
              </p>
              <ul className="space-y-1">
                {manualRows.map((r) => (
                  <li
                    key={r.householdId}
                    className="flex items-center justify-between gap-2 text-[13px]"
                  >
                    <span className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        {r.householdName}
                      </span>
                      <StatusChip
                        kind="billingLineItemReadingSource"
                        status="manual"
                      />
                    </span>
                    {r.totalAmount != null && (
                      <span className="text-muted-foreground">
                        <Currency value={r.totalAmount} bareNumber />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {allSelectedAreManual && (
            <p
              data-testid="regen-multi-all-manual-notice"
              className="text-[12px] text-muted-foreground"
            >
              All selected rows are manual — nothing to regenerate.
            </p>
          )}

          <p className="text-[12px] text-muted-foreground">
            Edge-only — to regenerate manual rows, use the row menu.
          </p>
        </div>
      }
    />
  );
}

/**
 * ResultDialog — parallel Radix Dialog used when the response had
 * errors.length > 0. Cannot use <ConfirmDialog> — its footer is fixed to
 * Cancel + Confirm/Retry and cannot host a "Close-only" view.
 *
 * Tone:
 *   - successCount === 0 (full failure)  → destructive banner.
 *   - successCount > 0  (partial failure) → warn banner + success summary.
 *
 * "Close" button calls `onOpenChange(false)`. Does NOT re-fire `onSuccess`.
 */
function ResultDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: ResultState;
}) {
  const { open, onOpenChange, result } = props;
  const { errors, successCount, attemptedCount } = result;
  const isFullFailure = successCount === 0;
  const tone: "destructive" | "warn" = isFullFailure ? "destructive" : "warn";

  // Preserve API response order (AC7) — do not re-sort by code/severity.
  const displayed = errors.slice(0, MAX_FAILURES_INLINE);
  const overflow = Math.max(0, errors.length - MAX_FAILURES_INLINE);

  const title = isFullFailure
    ? `Could not regenerate ${attemptedCount} household${attemptedCount === 1 ? "" : "s"}`
    : `Regenerated ${successCount} of ${attemptedCount} household${attemptedCount === 1 ? "" : "s"}`;

  const bannerTitle = isFullFailure
    ? `${errors.length} failure${errors.length === 1 ? "" : "s"}`
    : `${errors.length} household${errors.length === 1 ? "" : "s"} could not be regenerated`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
        <Dialog.Content
          role="alertdialog"
          aria-modal
          data-testid="regen-multi-result-dialog"
          onEscapeKeyDown={() => onOpenChange(false)}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "overflow-hidden rounded-md border border-border bg-card shadow-elev-3 outline-none",
          )}
        >
          <div
            aria-hidden="true"
            className={cn(
              "h-[6px]",
              isFullFailure ? "bg-destructive" : "bg-warning",
            )}
          />
          <div className="px-6 pb-2 pt-5">
            <Dialog.Title className="text-xl font-semibold tracking-tight">
              {title}
            </Dialog.Title>
          </div>

          <div className="px-6 pb-1">
            <Banner tone={tone} title={bannerTitle}>
              <ul
                data-testid="regen-multi-result-failure-list"
                className="mt-1 list-disc space-y-1 pl-5"
              >
                {displayed.map((err) => (
                  <li key={err.householdId}>{errorCodeCopy(err)}</li>
                ))}
                {overflow > 0 && (
                  <li
                    data-testid="regen-multi-result-failure-overflow"
                    className="font-medium"
                  >
                    + {overflow} more
                  </li>
                )}
              </ul>
            </Banner>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px]">
            <Dialog.Close asChild>
              <button
                type="button"
                data-testid="regen-multi-result-close"
                className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Close
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
