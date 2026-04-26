"use client";

// ConfirmDialog — single-purpose destructive confirm dialog.
//
// Interaction contract:
//   • Single-purpose destructive confirm. Can optionally require the user
//     to type a specific string to enable the Confirm button (see
//     `requireTypedConfirmation` — added in #89 for the entity-delete
//     blast-radius dialog). For the richer "Close Period" multi-channel
//     confirm, keep using <ClosePeriodDialog>.
//   • Cancel button is the first focusable element (defensive default
//     for destructive flows). When `requireTypedConfirmation` is set,
//     focus moves to the typed-input instead — it is the only actionable
//     element at that moment and focusing Cancel would be a keyboard-nav
//     oddity. Documented below.
//   • `onConfirm` may be async; component shows loading state (spinner
//     on confirm button) during the promise. Cancel remains enabled.
//   • On error, displays the thrown Error.message inline and offers a
//     Retry button; does NOT auto-close.
//   • On success, closes by calling onOpenChange(false).
//   • Accessibility: `role="alertdialog"` on the content element (the
//     correct WAI-ARIA pattern for destructive confirmations), and
//     `aria-describedby` wires up to both `description` and `body` when
//     supplied so screen-readers announce the blast-radius counts on
//     open.
//   • Use cases: Delete Period, Delete Meter, Delete Tenant, last-tier
//     warning, entity-delete (#89). Use <ClosePeriodDialog> only for
//     billing-period close.
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
  /**
   * Short plain-string description. Renders above the optional `body`.
   * Prefer `body` when you need a list, table, or other rich structure.
   */
  description?: string;
  /**
   * Rich-content area (ReactNode) rendered below `description` and above
   * the typed-confirmation input row. Used by the entity-delete flow to
   * surface the blast-radius list inside the dialog.
   */
  body?: React.ReactNode;
  confirmLabel: string;
  tone: "destructive" | "neutral";
  onConfirm: () => Promise<void>;
  /**
   * When supplied, renders a labelled input above the footer. The
   * Confirm button stays `disabled` until `input.value.trim() ===
   * expected.trim()` (case-sensitive, trimmed). Focus moves to the
   * input on open instead of Cancel.
   */
  requireTypedConfirmation?: {
    label: string;
    expected: string;
  };
  /**
   * Optional eyebrow label rendered above the title. 3-state semantic:
   *   - `undefined` (default): renders the per-tone default —
   *     `"Irreversible action"` for destructive, `"Confirm"` for neutral.
   *   - `string`: renders the supplied string verbatim as the eyebrow.
   *   - `null`: explicit opt-out — no eyebrow `<span>` is rendered (no
   *     DOM node, no reserved spacing). Use this when the dialog body
   *     itself is the primary visual focus and the eyebrow would add
   *     noise (e.g. BC3 paid-edge regenerate dialog where the diff body
   *     should be the first thing the operator sees).
   */
  eyebrow?: string | null;
}

type State = "idle" | "loading" | "error";

// Stable ids for a11y wiring. `aria-describedby` takes a space-separated
// list of ids — we include whichever ones are actually in the DOM.
const DESC_ID = "confirm-dialog-desc";
const BODY_ID = "confirm-dialog-body";

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  body,
  confirmLabel,
  tone,
  onConfirm,
  requireTypedConfirmation,
  eyebrow,
}: ConfirmDialogProps) {
  const [state, setState] = React.useState<State>("idle");
  const [errorMsg, setErrorMsg] = React.useState<string | null>(null);
  const [typedValue, setTypedValue] = React.useState("");
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Reset state whenever the dialog opens.
  React.useEffect(() => {
    if (open) {
      setState("idle");
      setErrorMsg(null);
      setTypedValue("");
    }
  }, [open]);

  const typedMatches = requireTypedConfirmation
    ? typedValue.trim() === requireTypedConfirmation.expected.trim()
    : true;

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

  // Compose aria-describedby — include only ids that will actually render.
  const describedByIds = [
    description ? DESC_ID : null,
    body !== undefined ? BODY_ID : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-foreground/55 data-[state=open]:animate-in data-[state=closed]:animate-out" />
        <Dialog.Content
          role="alertdialog"
          aria-modal
          aria-describedby={describedByIds || undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            // When a type-to-confirm input is present, it is the only
            // actionable element on open — focus it so keyboard users can
            // start typing immediately. Otherwise keep the defensive
            // cancel-first order.
            if (requireTypedConfirmation) {
              inputRef.current?.focus();
            } else {
              cancelRef.current?.focus();
            }
          }}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[94%] -translate-x-1/2 -translate-y-1/2",
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
            {/* Eyebrow — 3-state semantic via the `eyebrow` prop:
                  undefined → per-tone default ("Irreversible action" / "Confirm")
                  string    → render supplied label
                  null      → suppress the <span> entirely (no DOM, no spacing) */}
            {eyebrow !== null && (
              <span
                className={cn(
                  "text-[11px] font-semibold uppercase tracking-wide",
                  tone === "destructive" ? "text-destructive" : "text-primary",
                )}
              >
                {typeof eyebrow === "string"
                  ? eyebrow
                  : tone === "destructive"
                    ? "Irreversible action"
                    : "Confirm"}
              </span>
            )}
            <Dialog.Title className="mt-1.5 text-xl font-semibold tracking-tight">
              {title}
            </Dialog.Title>
            {description && (
              <Dialog.Description
                id={DESC_ID}
                className="mt-1 text-[13px] leading-relaxed text-muted-foreground"
              >
                {description}
              </Dialog.Description>
            )}
          </div>

          {body !== undefined && (
            <div
              id={BODY_ID}
              className="px-6 pb-1 text-[13px] leading-relaxed text-foreground"
            >
              {body}
            </div>
          )}

          {requireTypedConfirmation && (
            <div className="mt-3 px-6 pb-1">
              <label
                htmlFor="confirm-dialog-typed-input"
                className="mb-1 block text-[12px] font-medium text-foreground"
              >
                {requireTypedConfirmation.label}
              </label>
              <input
                ref={inputRef}
                id="confirm-dialog-typed-input"
                type="text"
                value={typedValue}
                onChange={(e) => setTypedValue(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-label={requireTypedConfirmation.label}
                className="block w-full rounded-md border border-border bg-card px-3 py-1.5 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder={requireTypedConfirmation.expected}
              />
            </div>
          )}

          {state === "error" && errorMsg && (
            <div className="px-6 pt-2">
              <div className="rounded-md bg-destructive-muted px-3 py-2.5 text-[13px] text-destructive-fg">
                {errorMsg}
              </div>
            </div>
          )}

          <div className="mt-4 flex items-center justify-end gap-2 bg-muted px-6 pb-[18px] pt-[14px]">
            {/* Cancel renders first — a11y cancel-first focus order when
                no type-to-confirm input is present (see onOpenAutoFocus). */}
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
                disabled={!typedMatches}
                className={cn(
                  "inline-flex h-8 items-center rounded-md border px-3.5 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 disabled:cursor-not-allowed",
                  confirmBtnCls,
                )}
              >
                Retry
              </button>
            ) : (
              <button
                onClick={handleConfirm}
                disabled={state === "loading" || !typedMatches}
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
