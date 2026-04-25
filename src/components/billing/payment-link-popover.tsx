"use client";

// PaymentLinkPopover — extracted URL display + copy popover.
//
// Originally lived inside `<PaymentLinkButton>` (deleted in BC2 #174).
// Now anchored to a hidden trigger element rendered next to the kebab in
// `<RowActionsMenu>`. The hidden trigger toggles `display: none`/inline
// based on whether a URL is in component state — see comment in
// `<RowActionsMenu>`.
//
// Spec preserved from `payment-link-button.tsx:162-235`:
//   - readonly URL input, monospace, selected on focus
//   - "Copy link" button → copies to clipboard, label flips to "Copied" for 2 s
//   - sr-only live region announces copy
//   - Close button + Esc + outside click all close + reset state
//   - 2000 ms COPIED_LABEL_DURATION_MS

import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";

const COPIED_LABEL_DURATION_MS = 2000;

export interface PaymentLinkPopoverProps {
  /** The URL to display + copy. When non-null, the popover anchors and opens. */
  url: string | null;
  /** Called when the popover should close (Esc, outside click, Close button). */
  onClose: () => void;
}

export function PaymentLinkPopover({ url, onClose }: PaymentLinkPopoverProps) {
  const [copied, setCopied] = React.useState(false);
  const copiedTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    return () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  // Reset copied state whenever a new URL arrives or the popover is dismissed.
  React.useEffect(() => {
    setCopied(false);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
  }, [url]);

  function handleCopyLink(value: string) {
    navigator.clipboard?.writeText(value).catch(() => {});
    setCopied(true);
    if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = setTimeout(() => {
      setCopied(false);
    }, COPIED_LABEL_DURATION_MS);
  }

  const open = url !== null;

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {/* Hidden anchor — Radix Popover requires a Trigger to anchor against.
          The trigger is invisible (aria-hidden + width:0) but stays in DOM
          so positioning works. The kebab is the visual anchor adjacent to
          this hidden trigger. */}
      <Popover.Trigger asChild>
        <span
          aria-hidden="true"
          tabIndex={-1}
          className="inline-block w-0 h-0"
          data-testid="payment-link-popover-anchor"
        />
      </Popover.Trigger>
      {open && url !== null && (
        <Popover.Portal>
          <Popover.Content
            align="end"
            sideOffset={6}
            onEscapeKeyDown={() => onClose()}
            onInteractOutside={() => onClose()}
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
              value={url}
              onFocus={(e) => e.currentTarget.select()}
              className={cn(
                "mb-3 w-full rounded-sm border border-border bg-muted px-2 py-1",
                "font-mono text-[11px] text-foreground",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                "truncate",
              )}
            />

            {/* live region announces copy */}
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              className="sr-only"
            >
              {copied ? "Payment link copied" : ""}
            </div>

            <div className="flex gap-2">
              {/* Primary: Copy link */}
              <button
                type="button"
                autoFocus
                onClick={() => handleCopyLink(url)}
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
                onClick={() => onClose()}
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
      )}
    </Popover.Root>
  );
}
