"use client";

// ConfirmDialog — single-purpose destructive confirm dialog.
//
// Interaction contract:
//   • Single-purpose destructive confirm. No type-to-confirm friction
//     (use <ClosePeriodDialog> for that).
//   • Cancel button is the first focusable element (defensive default
//     for destructive flows). Implemented via onOpenAutoFocus forwarding
//     focus to the Cancel button ref.
//   • `onConfirm` may be async; component shows loading state (spinner
//     on confirm button) during the promise. Cancel remains enabled.
//   • On error, displays the thrown Error.message inline and offers a
//     Retry button; does NOT auto-close.
//   • On success, closes by calling onOpenChange(false).
//   • Use cases: Delete Period, Delete Meter, Delete Tenant, last-tier
//     warning, etc. Use <ClosePeriodDialog> only for billing-period close.
//
// Tone:
//   • "destructive" — confirm button uses bg-destructive/text-destructive-foreground.
//   • "neutral"     — confirm button uses bg-primary/text-primary-foreground.

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { cn } from "@/lib/utils";

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  confirmLabel: string;
  tone: "destructive" | "neutral";
  onConfirm: () => Promise<void>;
}

type State = "idle" | "loading" | "error";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone,
  onConfirm,
}: ConfirmDialogProps) {
  const [state, setState] = React.useState<State>("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const cancelRef = React.useRef<HTMLButtonElement>(null);

  // Reset state whenever the dialog opens.
  React.useEffect(() => {
    if (open) {
      setState("idle");
      setErrorMsg(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    setState("loading");
    setErrorMsg(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : "An unexpected error occurred");
    }
  };

  const confirmBtnCls =
    tone === "destructive"
      ? "bg-destructive text-destructive-foreground border-destructive hover:opacity-90"
      : "bg-primary text-primary-foreground border-primary hover:opacity-90";

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55 data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content
          aria-modal
          aria-describedby={description ? "confirm-dialog-desc" : undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            cancelRef.current?.focus();
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[400px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "overflow-hidden rounded-md border border-border bg-card shadow-elev-3 outline-none",
          )}
        >
          {/* top rail — tone color */}
          <div
            aria-hidden="true"
            className={cn(
              "h-[6px]",
              tone === "destructive" ? "bg-destructive" : "bg-primary",
            )}
          />

          <div className="px-6 pb-2 pt-5">
            <span
              className={cn(
                "text-[11px] font-semibold uppercase tracking-wide",
                tone === "destructive" ? "text-destructive" : "text-primary",
              )}
            >
              {tone === "destructive" ? "Irreversible action" : "Confirm"}
            </span>
            <Dialog.Title className="mt-1.5 text-xl font-semibold tracking-tight">
              {title}
            </Dialog.Title>
            {description && (
              <Dialog.Description
                id="confirm-dialog-desc"
                className="mt-1 text-[13px] leading-relaxed text-muted-foreground"
              >
                {description}
              </Dialog.Description>
            )}
          </div>

          {state === "error" && errorMsg && (
            <div className="px-6 pt-2">
              <div className="rounded-md bg-destructive-muted px-3 py-2.5 text-[13px] text-destructive-fg">
                {errorMsg}
              </div>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px]">
            {/* Cancel renders first — a11y cancel-first focus order. */}
            <Dialog.Close asChild>
              <button
                ref={cancelRef}
                className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Cancel
              </button>
            </Dialog.Close>

            {state === "error" ? (
              <button
                onClick={handleConfirm}
                className={cn(
                  "inline-flex h-8 items-center rounded-md border px-3.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  confirmBtnCls,
                )}
              >
                Retry
              </button>
            ) : (
              <button
                onClick={handleConfirm}
                disabled={state === "loading"}
                className={cn(
                  "inline-flex h-8 items-center gap-2 rounded-md border px-3.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed",
                  confirmBtnCls,
                )}
              >
                {state === "loading" && (
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
                {confirmLabel}
              </button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
