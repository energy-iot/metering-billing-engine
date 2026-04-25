"use client";

// ClosePeriodDialog — Radix Dialog wrapping the close-period flow.
//
// Phases (internal state):
//   2   = confirm   — totals grid + grand total + checkbox
//                     ("I have copied the values for URA") + filled-primary
//                     "Close period" button (disabled until checkbox ticked).
//                     This is the open surface — no preceding "Review & close…"
//                     ceremony; the totals are visible immediately so the
//                     user can review and commit in a single gesture.
//   2.5 = pending   — disabled "Closing…" button while the mutation runs.
//   3   = closed    — green header + "Export CSV for URA" primary CTA.
//   E   = error     — destructive inline banner with "Retry close".
//
// A11y commitments (handled via Radix Dialog primitives):
//   • role="dialog" + aria-modal on the content panel.
//   • Focus trap while open; Esc to close; focus returns to trigger on close.
//   • Cancel renders BEFORE the confirm trigger in DOM order so screen-
//     reader users reach the safe option first. Radix's default would land
//     focus on the first focusable in DOM (the checkbox); we override that
//     via onOpenAutoFocus + cancelRef to keep cancel-first focus order.
//   • `aria-labelledby` references the dialog title; `aria-describedby`
//     references the warning copy.
//
// Why multi-channel confirm over typed-phrase:
//   The original typed "CLOSE 2026-03" phrase was shown on-screen, so the
//   user just typed (or pasted) what they saw — friction illusory. A
//   checkbox "I have copied the values for URA" + final "Close period"
//   button is a deliberate two-gesture commit AND names the real-world
//   precondition (the transcription must be done). Forks that want
//   typed-phrase ceremony can swap the confirm row.
//
// Tone calibration:
//   Closing a period is a final commit, not a destruction — destructive
//   tone is reserved for delete flows. The rail and eyebrow render in
//   primary tone; only the error-state banner and Retry button keep the
//   destructive tokens (genuine failure state).
//
// Un-billed warning (#167):
//   When `unfilledHouseholdNames` is non-empty, the dialog renders a
//   warning-toned banner above the totals grid listing the un-metered
//   households whose `usage_kwh` is still NULL. Closing is permitted —
//   Aaron may genuinely want to bill nothing for a tenant — but the
//   gesture becomes more deliberate: the confirm button label flips to
//   "Close anyway" and the checkbox copy gains an explicit acknowledgement
//   of the un-billed count. Tone uses warning tokens, not destructive,
//   per Design System rule 3 (this is a soft block, not a failure state).

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";
import { Currency } from "@/components/format/currency";

export type ClosePeriodSummaryRow = {
  label: string;
  value: React.ReactNode;
};

export interface ClosePeriodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** e.g. "March 2026" */
  periodLabel: string;
  summaryRows: ClosePeriodSummaryRow[];
  /** e.g. 4_216_800 — rendered with <Currency>. */
  grandTotal: number;
  /** Called when the user confirms. Return a promise; the dialog shows
   *  pending state while it resolves and error state on reject. */
  onConfirm: () => Promise<void>;
  /** Called when the user clicks "Export CSV for URA" in the closed state. */
  onExportCsv?: () => void;
  /** Display names of un-metered households whose `usage_kwh` is still NULL.
   *  When non-empty, the dialog renders a warning banner above the totals
   *  grid, flips the confirm button label to "Close anyway", and appends
   *  an acknowledgement of the un-billed count to the checkbox copy.
   *  Default: `[]` (no banner, original "Close period" behavior). */
  unfilledHouseholdNames?: string[];
}

type Phase = 2 | 2.5 | 3 | "E";

export function ClosePeriodDialog({
  open,
  onOpenChange,
  periodLabel,
  summaryRows,
  grandTotal,
  onConfirm,
  onExportCsv,
  unfilledHouseholdNames = [],
}: ClosePeriodDialogProps) {
  const [phase, setPhase] = React.useState<Phase>(2);
  const [confirmed, setConfirmed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  // Reset phase whenever the dialog is opened (don't carry state between openings).
  React.useEffect(() => {
    if (open) {
      setPhase(2);
      setConfirmed(false);
      setError(null);
    }
  }, [open]);

  const handleClose = async () => {
    setPhase(2.5);
    setError(null);
    try {
      await onConfirm();
      setPhase(3);
    } catch (err) {
      setPhase("E");
      setError(err instanceof Error ? err.message : "Network error");
    }
  };

  const title =
    phase === 3
      ? `Closed: ${periodLabel}`
      : `Close ${periodLabel} billing period?`;

  const description =
    phase === 3
      ? "This period is now read-only. Export the CSV for your URA filing."
      : "Bills become final. This period will be filed with URA — values copied after this are the values you report.";

  // #167 — un-billed warning derivations. Only relevant in the pre-close
  // phases (2 / 2.5 / E); the closed surface intentionally drops the
  // banner since the period is now committed and listing the un-billed
  // households after-the-fact would be misleading.
  const unfilledCount = unfilledHouseholdNames.length;
  const hasUnfilled = unfilledCount > 0 && phase !== 3;
  const unfilledHouseholdsWord = unfilledCount === 1 ? "household" : "households";
  const unfilledNamesPreview = unfilledHouseholdNames.slice(0, 5).join(", ");
  const unfilledNamesOverflow = unfilledCount > 5 ? unfilledCount - 5 : 0;
  const confirmButtonLabel = hasUnfilled ? "Close anyway" : "Close period";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55 data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content
          // Cancel-first focus order: when the dialog opens, Radix tries to
          // focus the first focusable element inside (the checkbox in the
          // collapsed surface). We explicitly forward initial focus to the
          // Cancel button below via onOpenAutoFocus.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
          aria-describedby="close-period-desc"
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[480px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "overflow-hidden rounded-md border border-border bg-card shadow-elev-3",
            "outline-none",
          )}
        >
          {/* primary top-rail — 6px, token color (commit moment, not destruction) */}
          <div aria-hidden="true" className="h-[6px] bg-primary" />

          <div
            className={cn(
              "px-6 pb-2 pt-5",
              phase === 3 && "bg-success-muted",
            )}
          >
            <span
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wide",
                phase === 3 ? "text-success-fg" : "text-primary",
              )}
            >
              {phase === 3 ? "Closed" : "Final review"}
            </span>
            <Dialog.Title className="mt-1.5 text-xl font-semibold tracking-tight">
              {title}
            </Dialog.Title>
            <Dialog.Description
              id="close-period-desc"
              className="mt-1 text-[13px] leading-relaxed text-muted-foreground"
            >
              {description}
            </Dialog.Description>
          </div>

          {hasUnfilled && (
            <div className="px-6 pt-3">
              <div
                data-testid="close-period-unfilled-banner"
                role="alert"
                className="rounded-md bg-warning-muted px-3 py-2.5 text-[13px] text-warning-fg"
              >
                <div className="font-semibold">
                  {unfilledCount} {unfilledHouseholdsWord} still un-billed
                </div>
                <div className="mt-0.5">
                  {unfilledNamesPreview}
                  {unfilledNamesOverflow > 0 ? ` + ${unfilledNamesOverflow} more` : ""}
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 px-6 pt-3">
            {summaryRows.map((r, i) => (
              <div key={i} className="rounded-md bg-muted px-2.5 py-2">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {r.label}
                </div>
                <div className="mt-0.5 font-mono text-sm font-semibold tabular-nums">
                  {r.value}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-2 flex items-center justify-between border-t border-dashed border-border px-6 pb-1 pt-2">
            <div className="text-[12px] text-muted-foreground">Grand total</div>
            <Currency value={grandTotal} className="text-[22px] font-semibold" />
          </div>

          {phase === 2 && (
            <div className="px-6 pb-1 pt-3">
              <label className="flex cursor-pointer items-start gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 accent-[color:var(--primary)]"
                />
                <span>
                  I have copied the tier values into URA&apos;s portal and confirm these
                  totals are what I will file.
                  {hasUnfilled
                    ? ` (including ${unfilledCount} un-billed ${unfilledHouseholdsWord})`
                    : ""}
                </span>
              </label>
            </div>
          )}

          {phase === "E" && (
            <div className="px-6 pt-3">
              <div className="rounded-md bg-destructive-muted px-3 py-2.5 text-[13px] text-destructive-fg">
                <b>Couldn&apos;t close period.</b> {error ?? "Network error"}. Your draft is
                unchanged.
              </div>
            </div>
          )}

          <div className="mt-3 flex items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px]">
            <div className="mr-auto text-[11px] text-muted-foreground">
              {phase === 3 ? (
                <span className="inline-flex items-center gap-1 font-semibold text-success-fg">
                  ✓ Closed · read-only
                </span>
              ) : phase === 2.5 ? (
                "Closing…"
              ) : (
                "You can still generate again before closing."
              )}
            </div>
            {/* Cancel renders first — a11y focus-first order. */}
            <Dialog.Close asChild>
              <button
                ref={cancelRef}
                className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
            </Dialog.Close>
            {phase === 2 && (
              <button
                onClick={handleClose}
                disabled={!confirmed}
                className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {confirmButtonLabel}
              </button>
            )}
            {phase === 2.5 && (
              <button
                disabled
                className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground opacity-60 cursor-not-allowed"
              >
                Closing…
              </button>
            )}
            {phase === 3 && (
              <button
                onClick={onExportCsv}
                className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Export CSV for URA
              </button>
            )}
            {phase === "E" && (
              <button
                onClick={handleClose}
                className="inline-flex h-8 items-center rounded-md border border-destructive bg-destructive px-3.5 text-[13px] font-medium text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Retry close
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
