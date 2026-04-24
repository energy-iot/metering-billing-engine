"use client";

// PaymentLinkButton — per-row action button that posts to the payment-link
// generation route and surfaces the result in a Radix Popover.
//
// States:
//   idle      → enabled button labelled "Payment link"
//   loading   → disabled button with spinner + "Generating…", aria-busy="true"
//   success   → Popover open; readonly URL input + [Copy link] / [Copied] / [Close]
//   error     → Chip tone="alert" + Retry link for 8 s, then reverts to idle
//
// Spec constraints (PM + Designer locked):
//   - NO window.open — Aaron pastes into WhatsApp; auto-open is friction
//   - orderTrackingId / merchantReference NOT rendered
//   - Error chip collapses ALL failure reasons to "Failed" (no reason-specific copy)
//   - 8000 ms error chip duration (Designer-pinned)
//   - 2000 ms "Copied" label after clipboard write
//   - Retry mints a NEW request (no caching)

import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { Chip } from "@/components/ui/chip";

export interface PaymentLinkButtonProps {
  lineItemId: string;
  /** When false, button is disabled and aria-describedby points at the gate banner. */
  disabled: boolean;
}

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; url: string }
  | { kind: "error" };

const GATE_BANNER_ID = "payment-gate-banner";
const ERROR_CHIP_DURATION_MS = 8000;
const COPIED_LABEL_DURATION_MS = 2000;

export function PaymentLinkButton({ lineItemId, disabled }: PaymentLinkButtonProps) {
  const [state, setState] = React.useState<State>({ kind: "idle" });
  const [popoverOpen, setPopoverOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  // Cleanup timeouts on unmount
  const errorTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  async function handleClick() {
    if (disabled || state.kind === "loading") return;

    setState({ kind: "loading" });
    try {
      const res = await fetch(`/api/billing-line-items/${lineItemId}/url`, {
        method: "POST",
      });

      if (!res.ok) {
        showError();
        return;
      }

      const data = (await res.json()) as {
        redirectUrl: string;
        orderTrackingId: string;
        merchantReference: string;
      };

      setState({ kind: "success", url: data.redirectUrl });
      setPopoverOpen(true);
    } catch {
      showError();
    }
  }

  function showError() {
    setState({ kind: "error" });
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setState({ kind: "idle" });
    }, ERROR_CHIP_DURATION_MS);
  }

  function handleRetry() {
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    setState({ kind: "idle" });
    // Trigger click after resetting to idle
    setTimeout(() => handleClick(), 0);
  }

  function handleCopyLink(url: string) {
    navigator.clipboard?.writeText(url).catch(() => {});
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setCopied(false);
    }, COPIED_LABEL_DURATION_MS);
  }

  function handlePopoverOpenChange(open: boolean) {
    setPopoverOpen(open);
    if (!open) {
      // Reset copied state when popover closes
      setCopied(false);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      // Return to idle so next click mints a fresh request
      setState({ kind: "idle" });
    }
  }

  // Error state: chip + retry, no popover
  if (state.kind === "error") {
    return (
      <span className="inline-flex items-center gap-1.5">
        <Chip tone="alert" dot role="alert">
          Failed
        </Chip>
        <button
          type="button"
          onClick={handleRetry}
          className="text-[11px] font-medium text-destructive-fg underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Retry
        </button>
      </span>
    );
  }

  const triggerButton = (
    <button
      type="button"
      disabled={disabled || state.kind === "loading"}
      aria-busy={state.kind === "loading" ? "true" : undefined}
      aria-describedby={disabled ? GATE_BANNER_ID : undefined}
      onClick={handleClick}
      className={cn(
        "inline-flex h-6 items-center gap-1 rounded-md border border-border bg-card px-2 text-[11px] font-medium text-foreground",
        "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
      )}
    >
      {state.kind === "loading" ? (
        <>
          <Spinner />
          Generating…
        </>
      ) : (
        "Payment link"
      )}
    </button>
  );

  // Success state: wrap trigger in Popover
  if (state.kind === "success") {
    return (
      <Popover.Root open={popoverOpen} onOpenChange={handlePopoverOpenChange}>
        <Popover.Trigger asChild>{triggerButton}</Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            onEscapeKeyDown={() => handlePopoverOpenChange(false)}
            onInteractOutside={() => handlePopoverOpenChange(false)}
            className={cn(
              "z-50 w-80 rounded-md border border-border bg-card p-3 shadow-elev-3 outline-none",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
              "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            )}
          >
            <div className="mb-2 text-[12px] font-semibold text-foreground">
              Payment link
            </div>

            {/* URL input — readonly, selectable on focus */}
            <input
              type="text"
              readOnly
              value={state.url}
              onFocus={(e) => e.currentTarget.select()}
              className={cn(
                "mb-3 w-full rounded-sm border border-border bg-muted px-2 py-1",
                "font-mono text-[11px] text-foreground",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "truncate",
              )}
            />

            {/* live region announces copy */}
            <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
              {copied ? "Payment link copied" : ""}
            </div>

            <div className="flex gap-2">
              {/* Primary: Copy link */}
              <button
                type="button"
                autoFocus
                onClick={() => handleCopyLink(state.url)}
                className={cn(
                  "flex-1 rounded-md py-1 text-[12px] font-medium",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  copied
                    ? "bg-success-muted text-success-fg"
                    : "bg-primary text-primary-foreground hover:opacity-90",
                )}
              >
                {copied ? "Copied" : "Copy link"}
              </button>

              {/* Secondary: Close */}
              <button
                type="button"
                onClick={() => handlePopoverOpenChange(false)}
                className={cn(
                  "rounded-md border border-border bg-card px-3 py-1 text-[12px] font-medium text-foreground",
                  "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
              >
                Close
              </button>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    );
  }

  // Idle and loading states: plain button (no popover)
  return triggerButton;
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
