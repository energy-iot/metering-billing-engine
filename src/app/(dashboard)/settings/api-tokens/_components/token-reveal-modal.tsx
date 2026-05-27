"use client";

import * as React from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Banner } from "@/components/ui/banner";
import { cn } from "@/lib/utils";

export interface TokenRevealModalProps {
  open: boolean;
  plaintext: string | null;
  onOpenChange: (open: boolean) => void;
}

/**
 * TokenRevealModal — one-time plaintext display (#256).
 *
 * Invariants:
 *   • Plaintext is passed in as a prop; the parent holds the state and
 *     wipes it (`setRevealedPlaintext(null)`) when `onOpenChange(false)`
 *     fires. This component never persists the value past its own render.
 *   • Closing the modal triggers `onOpenChange(false)` via Radix's
 *     Dialog primitive (overlay click, ESC, or "Done" button). The parent
 *     is then responsible for clearing state — we trust the parent and
 *     do not duplicate the wipe here.
 *   • No "copy succeeded" toast that lingers — the inline button label
 *     flips to "Copied!" for 2s and resets. Operator confirmation
 *     happens in their clipboard, not in a sticky UI.
 *
 * Accessibility:
 *   • `role="alertdialog"` so screen readers treat it as a confirmation
 *     surface (the plaintext is a destructive-to-leak secret; the modal
 *     is a one-shot reveal).
 *   • Plaintext is rendered in a <code> block with `aria-label="Token
 *     plaintext — copy now"`.
 */
export function TokenRevealModal(props: TokenRevealModalProps) {
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (!props.open) {
      // Reset copy-button state whenever modal closes.
      setCopied(false);
    }
  }, [props.open]);

  async function handleCopy() {
    if (!props.plaintext) return;
    try {
      await navigator.clipboard.writeText(props.plaintext);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access denied (older browsers / permission policy).
      // Operator can select-and-copy manually.
      setCopied(false);
    }
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55" />
        <Dialog.Content
          role="alertdialog"
          aria-modal
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
            "overflow-hidden rounded-md border border-border bg-card shadow-elev-3 outline-none"
          )}
        >
          <div aria-hidden="true" className="h-[6px] bg-warning" />

          <div className="px-6 pt-5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-warning-fg">
              Shown once
            </span>
            <Dialog.Title className="mt-1.5 text-xl font-semibold tracking-tight text-foreground">
              Save this token now
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
              MBE cannot show this plaintext again. Paste it into your
              customerapp configuration before closing this dialog.
            </Dialog.Description>
          </div>

          <div className="space-y-3 px-6 pb-2 pt-4">
            <Banner tone="warn" title="One-time reveal">
              Closing this dialog wipes the token from this surface. If you
              lose it, you must <strong>Regenerate</strong> to mint a fresh
              one — every customerapp instance using the old token will
              then get 401 errors until reconfigured.
            </Banner>

            <div className="rounded-md border border-border bg-muted p-3">
              <code
                aria-label="Token plaintext — copy now"
                className="block break-all font-mono text-[13px] text-foreground"
              >
                {props.plaintext ?? ""}
              </code>
            </div>

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={handleCopy}
                className="inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-3.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {copied ? "Copied!" : "Copy to clipboard"}
              </button>
              <p className="text-xs text-muted-foreground">
                Treat this token like a password.
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px]">
            <Dialog.Close asChild>
              <button
                type="button"
                className="inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Done — token saved
              </button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
