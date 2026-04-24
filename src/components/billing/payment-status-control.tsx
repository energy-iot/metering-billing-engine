"use client";

// PaymentStatusControl — per-row payment-status chip + action dropdown.
//
// Renders a <StatusChip kind="billingLineItemPaymentStatus"> as a Radix
// DropdownMenu trigger. The dropdown exposes the single valid manual transition
// for the current state.
//
// State machine (manual tier — full matrix in src/lib/payments/state.ts):
//   unpaid   → "Mark as paid…"   (ConfirmDialog with notes)
//   paid     → "Mark as unpaid"  (immediate optimistic flip, no dialog)
//   failed   → "Mark as paid…"   (operator override of a failed IPN)
//   refunded → disabled item "No manual actions available" (terminal)
//
// Optimistic updates:
//   • flip chip immediately on action, before PATCH resolves
//   • on error: revert + inline <Banner tone="destructive"> for 5 s
//
// Accessibility:
//   • DropdownMenu.Trigger uses the chip as asChild with aria-haspopup + aria-expanded
//   • Chip is given an accessible label: "Payment status <status>, open actions"
//   • ConfirmDialog inherits existing alertdialog a11y (cancel-first focus)
//   • Inline error banner uses role="alert" (via Banner destructive tone)

import * as React from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { StatusChip } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Banner } from "@/components/ui/banner";
import { Currency } from "@/components/format/currency";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PaymentStatus = "unpaid" | "paid" | "failed" | "refunded";

export interface PaymentStatusControlLineItem {
  id: string;
  payment_status: PaymentStatus;
  /** Display name of the household (for the ConfirmDialog body). */
  household_name?: string;
  /** Period label, e.g. "Mar 1 – Mar 31, 2026" (for the ConfirmDialog body). */
  period_label?: string;
  /** Total amount billed (for the ConfirmDialog body). */
  total_amount: number;
  /** Currency code for the <Currency> formatter. */
  currency: string;
}

export interface PaymentStatusControlProps {
  lineItem: PaymentStatusControlLineItem;
  /**
   * Called when the PATCH succeeds, so the parent can refresh its own
   * data if needed. The updated status is passed as an argument.
   */
  onStatusChange?: (newStatus: PaymentStatus) => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const ERROR_BANNER_DURATION_MS = 5000;

// ── Component ─────────────────────────────────────────────────────────────────

export function PaymentStatusControl({
  lineItem,
  onStatusChange,
}: PaymentStatusControlProps) {
  const [optimisticStatus, setOptimisticStatus] = React.useState<PaymentStatus>(
    lineItem.payment_status,
  );
  const [isLoading, setIsLoading] = React.useState(false);
  const [dropdownOpen, setDropdownOpen] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [notes, setNotes] = React.useState("");
  const errorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep optimistic status in sync when the prop changes (e.g. page refresh).
  React.useEffect(() => {
    setOptimisticStatus(lineItem.payment_status);
  }, [lineItem.payment_status]);

  React.useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  function showError(msg: string) {
    setErrorMsg(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setErrorMsg(null);
    }, ERROR_BANNER_DURATION_MS);
  }

  // PATCH the server and handle success/error.
  async function patchStatus(
    newStatus: PaymentStatus,
    notesValue: string | null,
  ) {
    const prev = optimisticStatus;
    setOptimisticStatus(newStatus); // optimistic
    setIsLoading(true);

    try {
      const res = await fetch(
        `/api/billing-line-items/${lineItem.id}/payment-status`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: newStatus,
            ...(notesValue ? { notes: notesValue } : {}),
          }),
        },
      );

      if (!res.ok) {
        const data = (await res.json()) as { error?: string; reason?: string };
        setOptimisticStatus(prev); // revert
        showError(data.error ?? "Failed to update payment status.");
        return;
      }

      onStatusChange?.(newStatus);
    } catch {
      setOptimisticStatus(prev); // revert on network error
      showError("Network error. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  // "Mark as paid…" — open ConfirmDialog.
  function handleMarkAsPaid() {
    setNotes("");
    setConfirmOpen(true);
  }

  // ConfirmDialog onConfirm — fires PATCH with notes.
  async function handleConfirmPaid() {
    await patchStatus("paid", notes.trim() || null);
  }

  // "Mark as unpaid" — immediate optimistic flip, no dialog.
  function handleMarkAsUnpaid() {
    void patchStatus("unpaid", null);
  }

  // Compute dropdown items for the current optimistic status.
  const items = getDropdownItems(optimisticStatus, {
    onMarkAsPaid: handleMarkAsPaid,
    onMarkAsUnpaid: handleMarkAsUnpaid,
  });

  return (
    <div className="inline-flex flex-col items-start gap-1">
      {/* Error banner — 5 s auto-dismiss, inline above chip */}
      {errorMsg && (
        <Banner tone="destructive" title="Error" className="text-[11px] py-1 px-2">
          {errorMsg}
        </Banner>
      )}

      <DropdownMenu.Root open={dropdownOpen} onOpenChange={setDropdownOpen}>
        <DropdownMenu.Trigger asChild disabled={isLoading}>
          {/* Chip wrapper — must be a focusable element for the dropdown trigger.
              asChild passes props to the inner span; we wrap in a button-like span
              with cursor-pointer so it's clearly interactive. */}
          <span
            role="button"
            tabIndex={0}
            aria-haspopup="menu"
            aria-expanded={dropdownOpen}
            aria-label={`Payment status ${optimisticStatus}, open actions`}
            aria-busy={isLoading ? "true" : undefined}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setDropdownOpen(true);
              }
            }}
            className={cn(
              "inline-flex cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isLoading && "opacity-60 cursor-not-allowed",
            )}
          >
            {isLoading ? (
              <span className="inline-flex items-center gap-1">
                <StatusChip
                  kind="billingLineItemPaymentStatus"
                  status={optimisticStatus}
                />
                <Spinner />
              </span>
            ) : (
              <StatusChip
                kind="billingLineItemPaymentStatus"
                status={optimisticStatus}
              />
            )}
          </span>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className={cn(
              "z-50 min-w-[180px] overflow-hidden rounded-md border border-border bg-card shadow-elev-3",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
              "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            )}
          >
            {items.map((item) =>
              item.disabled ? (
                <DropdownMenu.Item
                  key={item.key}
                  disabled
                  className="flex cursor-not-allowed select-none items-center px-3 py-2 text-[12px] text-muted-foreground"
                >
                  {item.label}
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item
                  key={item.key}
                  onSelect={item.onSelect}
                  className={cn(
                    "flex cursor-pointer select-none items-center px-3 py-2 text-[12px] text-foreground",
                    "outline-none hover:bg-muted focus:bg-muted",
                  )}
                >
                  {item.label}
                </DropdownMenu.Item>
              ),
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* ConfirmDialog for mark-as-paid — neutral tone, notes textarea */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) setNotes("");
        }}
        title="Mark this bill as paid"
        tone="neutral"
        confirmLabel="Mark as paid"
        onConfirm={handleConfirmPaid}
        body={
          <div className="space-y-3 mt-1">
            {/* Household + period + amount summary */}
            <div className="text-[13px] leading-relaxed text-muted-foreground">
              {lineItem.household_name && (
                <span className="font-medium text-foreground">
                  {lineItem.household_name}
                </span>
              )}
              {lineItem.period_label && (
                <span>
                  {lineItem.household_name ? " · " : ""}
                  {lineItem.period_label}
                </span>
              )}
              {" · "}
              <span className="font-medium text-foreground">
                <Currency value={lineItem.total_amount} />
              </span>
            </div>

            {/* Optional notes textarea */}
            <div>
              <label
                htmlFor="payment-status-notes"
                className="mb-1 block text-[12px] font-medium text-foreground"
              >
                Reason or reference{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
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
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type DropdownItem = {
  key: string;
  label: string;
  disabled?: boolean;
  onSelect?: () => void;
};

function getDropdownItems(
  status: PaymentStatus,
  handlers: {
    onMarkAsPaid: () => void;
    onMarkAsUnpaid: () => void;
  },
): DropdownItem[] {
  switch (status) {
    case "unpaid":
    case "failed":
      return [
        {
          key: "mark-paid",
          label: "Mark as paid…", // ellipsis = dialog follows
          onSelect: handlers.onMarkAsPaid,
        },
      ];
    case "paid":
      return [
        {
          key: "mark-unpaid",
          label: "Mark as unpaid",
          onSelect: handlers.onMarkAsUnpaid,
        },
      ];
    case "refunded":
      return [
        {
          key: "no-actions",
          label: "No manual actions available",
          disabled: true,
        },
      ];
    default:
      // Fallback for unrecognised status values (e.g. future enum additions).
      return [
        {
          key: "no-actions",
          label: "No manual actions available",
          disabled: true,
        },
      ];
  }
}

function Spinner() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="animate-spin"
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}
