"use client";

// PaymentNotesConfirmDialog — reusable ConfirmDialog body for the
// "Mark as paid…" / "Mark as refunded…" flows.
//
// Extracted from the original `<PaymentStatusControl>` body (deleted in
// BC2 #174). Wraps the shared `<ConfirmDialog tone="neutral">` and renders
// a household / period / amount summary line plus an optional notes
// textarea (max 500 chars).
//
// The caller owns the `onConfirm` PATCH; this component is presentational
// + state for the textarea only.

import * as React from "react";
import { cn } from "@/lib/utils";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Currency } from "@/components/format/currency";

export interface PaymentNotesConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog title shown in the header (e.g. "Mark this bill as paid"). */
  title: string;
  /** Confirm button label (e.g. "Mark as paid"). */
  confirmLabel: string;
  /** Household display name; rendered as a bold prefix in the summary line. */
  householdName?: string;
  /** Period label (e.g. "Mar 1 – Mar 31, 2026"); separated by " · ". */
  periodLabel?: string;
  /** Total amount billed; rendered through `<Currency>`. */
  totalAmount: number;
  /** Currency code; passed via locale context, but explicit here for completeness. */
  currency?: string;
  /**
   * Receives the trimmed notes string when the user confirms. Caller fires
   * the PATCH and resolves; on error throws so `<ConfirmDialog>` shows the
   * inline retry surface.
   */
  onConfirm: (notes: string) => Promise<void>;
}

export function PaymentNotesConfirmDialog({
  open,
  onOpenChange,
  title,
  confirmLabel,
  householdName,
  periodLabel,
  totalAmount,
  onConfirm,
}: PaymentNotesConfirmDialogProps) {
  const [notes, setNotes] = React.useState("");

  // Reset notes whenever the dialog closes (idempotent on open too).
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      onOpenChange(next);
      if (!next) setNotes("");
    },
    [onOpenChange],
  );

  const handleConfirm = React.useCallback(async () => {
    await onConfirm(notes.trim());
  }, [notes, onConfirm]);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={handleOpenChange}
      title={title}
      tone="neutral"
      confirmLabel={confirmLabel}
      onConfirm={handleConfirm}
      body={
        <div className="mt-1 space-y-3">
          {/* Household + period + amount summary */}
          <div className="text-[13px] leading-relaxed text-muted-foreground">
            {householdName && (
              <span className="font-medium text-foreground">
                {householdName}
              </span>
            )}
            {periodLabel && (
              <span>
                {householdName ? " · " : ""}
                {periodLabel}
              </span>
            )}
            {" · "}
            <span className="font-medium text-foreground">
              <Currency value={totalAmount} />
            </span>
          </div>

          {/* Optional notes textarea */}
          <div>
            <label
              htmlFor="payment-status-notes"
              className="mb-1 block text-[12px] font-medium text-foreground"
            >
              Reason or reference{" "}
              <span className="font-normal text-muted-foreground">
                (optional)
              </span>
            </label>
            <textarea
              id="payment-status-notes"
              aria-label="Payment notes (optional, max 500 characters)"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              rows={2}
              placeholder="e.g. Cash 2026-04-24, M-Pesa receipt #123"
              className={cn(
                "block w-full rounded-md border border-border bg-card px-3 py-1.5",
                "text-[13px] text-foreground placeholder:text-muted-foreground",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "resize-none",
              )}
            />
            <p className="mt-0.5 text-right text-[11px] text-muted-foreground">
              {notes.length}/500
            </p>
          </div>
        </div>
      }
    />
  );
}
