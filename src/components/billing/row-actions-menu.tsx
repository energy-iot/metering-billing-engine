"use client";

// RowActionsMenu — consolidated per-row kebab menu for the BillingTable
// Status column (BC2 #174). Replaces the deleted `<PaymentRowActions>` /
// `<PaymentStatusControl>` / `<PaymentLinkButton>` trio.
//
// Renders horizontally:
//   [Source chip] [Status chip] [⋮]
//                                ↑ kebab opens a Radix DropdownMenu whose
//                                  items are computed from
//                                  (reading_source, payment_status,
//                                   edgeAvailable, period.status,
//                                   isPaymentConfigured).
//
// The dropdown surfaces:
//   - Regenerate / Switch source — calls optional `onRequestRegenerate` /
//     `onRequestSwitchToManual` props (BC3 wires real handlers); when
//     omitted, falls back to `onRowBanner({ tone: 'info', … })` so the
//     surface is always discoverable in BC2.
//   - Payment-link generate / regenerate / copy — owns the POST to
//     `/api/billing-line-items/[id]/url` and anchors a `<PaymentLinkPopover>`
//     to a hidden trigger when a URL is in component state.
//   - Payment-status transitions — every `ALLOWED_MANUAL_TRANSITIONS` entry
//     for the current `from` state surfaces as a menu item (3 items from
//     `link_generated`). Confirmations for paid/refunded route through
//     `<PaymentNotesConfirmDialog>`; cancel-link / mark-failed use a plain
//     neutral `<ConfirmDialog>`.
//   - View household + View history — plain `<Link>`s.
//
// IPN auto-close: tracks the previous `payment_status` via a ref. When the
// prop changes (parent's polling `router.refresh()` re-renders the server
// component) AND the menu is open, closes the menu and pushes an info
// banner so the operator notices the change.

import * as React from "react";
import Link from "next/link";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { cn } from "@/lib/utils";
import { StatusChip } from "@/components/ui/status-chip";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PaymentNotesConfirmDialog } from "@/components/billing/payment-notes-confirm-dialog";
import { PaymentLinkPopover } from "@/components/billing/payment-link-popover";
import type { RowBannerEntry } from "@/components/billing/row-banner-stack";
import type {
  BillingLineItemPaymentStatus,
  BillingPeriodStatus,
  ReadingSource,
} from "@/lib/types/domain";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RowActionsMenuLineItem {
  id: string;
  payment_status: BillingLineItemPaymentStatus;
  reading_source: ReadingSource;
  total_amount: number;
}

export interface RowActionsMenuHousehold {
  id: string;
  display_name: string;
}

export interface RowActionsMenuPeriod {
  id: string;
  status: BillingPeriodStatus;
  start_date: string;
  end_date: string;
}

export interface RowActionsMenuProps {
  microgridId: string;
  lineItem: RowActionsMenuLineItem;
  household: RowActionsMenuHousehold;
  period: RowActionsMenuPeriod;
  /** Whether the household has a primary_consumption_meter device on a
   *  configured edge. Drives visibility of "Switch back to edge data" /
   *  "Regenerate from edge data". */
  edgeAvailable: boolean;
  /** Whether the community has a payment provider configured. */
  isPaymentConfigured: boolean;
  /** Push a transient banner into <RowBannerStack> for this line item id. */
  onRowBanner: (entry: RowBannerEntry) => void;
  /** Stub callbacks for BC3 to wire later (regenerate dialogs); BC2 ships
   *  them as no-op TODO-banners when not provided. */
  onRequestRegenerate?: (mode: "edge" | "manual") => void;
  onRequestSwitchToManual?: () => void;
}

// ── Menu item shape ───────────────────────────────────────────────────────────

/** A single rendered dropdown item. Pure data — `<RowActionsMenu>` decides
 *  how to render (link / button / disabled / separator / warning subtext). */
export type MenuItem =
  | {
      kind: "action";
      key: string;
      label: string;
      /** Optional secondary line, rendered in muted text below the label. */
      subtext?: string;
      /** Render a leading "⚠ " prefix to the label. */
      warning?: boolean;
      /** Marks the item disabled; click is a no-op. */
      disabled?: boolean;
      onSelect: () => void;
    }
  | {
      kind: "link";
      key: string;
      label: string;
      href: string;
    }
  | {
      kind: "separator";
      key: string;
    };

// ── Pure menu-items computation ───────────────────────────────────────────────

/**
 * Compute the dropdown items for a row given the rendering inputs. Pure
 * function — no side effects. Assertion-tested via inclusion checks (NOT
 * snapshots) for the 6 named states from the designer matrix; see
 * `__tests__/row-actions-menu.test.tsx`.
 */
export function computeMenuItems(input: {
  microgridId: string;
  lineItem: RowActionsMenuLineItem;
  household: RowActionsMenuHousehold;
  period: RowActionsMenuPeriod;
  edgeAvailable: boolean;
  isPaymentConfigured: boolean;
  /** Most recently fetched URL — when set, "Copy payment link" surfaces. */
  pendingUrl: string | null;
  handlers: {
    onRequestRegenerate: (mode: "edge" | "manual") => void;
    onRequestSwitchToManual: () => void;
    onGenerateLink: () => void;
    onCopyLink: () => void;
    onMarkAsPaid: () => void;
    onMarkAsRefunded: () => void;
    onMarkAsUnpaid: () => void;
    onCancelLink: () => void;
    onMarkAsFailed: () => void;
    /** PDF3 (#205) — fires the bill-PDF download flow (probe-then-anchor). */
    onDownloadPdf: () => void;
  };
}): MenuItem[] {
  const {
    microgridId,
    lineItem,
    household,
    period,
    edgeAvailable,
    isPaymentConfigured,
    pendingUrl,
    handlers,
  } = input;

  const items: MenuItem[] = [];

  const isManual = lineItem.reading_source === "manual";
  const isEdge = lineItem.reading_source === "edge";
  const isClosed = period.status === "closed";
  const isPaid = lineItem.payment_status === "paid";
  const isTerminal = lineItem.payment_status === "refunded";

  // Subtext shown beneath any "regenerate" item that fires against a
  // closed period (Q4=B). For paid rows the warning prefix is added too.
  const closedSubtext = isClosed ? "Logged as audit revision." : undefined;
  const regenWarning = isClosed || isPaid;

  // ── Source / regenerate group ──────────────────────────────────────────────
  // Hidden entirely on terminal (refunded) rows — refunding then re-billing
  // reads as data corruption (designer note in matrix card #5).
  if (!isTerminal) {
    if (isEdge) {
      // Edge → Regenerate from edge (only when edge is available) +
      // Switch to manual entry.
      if (edgeAvailable) {
        items.push({
          kind: "action",
          key: "regen-edge",
          label: "Regenerate from edge data",
          warning: regenWarning,
          subtext: closedSubtext,
          onSelect: () => handlers.onRequestRegenerate("edge"),
        });
      }
      items.push({
        kind: "action",
        key: "switch-manual",
        label: "Switch to manual entry…",
        warning: regenWarning,
        subtext: closedSubtext,
        onSelect: () => handlers.onRequestSwitchToManual(),
      });
    } else if (isManual) {
      // Manual → Switch back to edge (HIDDEN if no edge available) +
      // Re-enter manual readings.
      if (edgeAvailable) {
        items.push({
          kind: "action",
          key: "switch-edge",
          label: "Switch back to edge data",
          warning: regenWarning,
          subtext: closedSubtext,
          onSelect: () => handlers.onRequestRegenerate("edge"),
        });
      }
      items.push({
        kind: "action",
        key: "regen-manual",
        label: "Re-enter manual readings…",
        warning: regenWarning,
        subtext: closedSubtext,
        onSelect: () => handlers.onRequestRegenerate("manual"),
      });
    }
  }

  const hasSourceGroup = items.length > 0;

  // ── Payment-link group ─────────────────────────────────────────────────────
  // Hidden entirely when payment is not configured (gate banner above the
  // table already explains why).
  const paymentLinkItems: MenuItem[] = [];
  if (isPaymentConfigured && !isTerminal) {
    if (lineItem.payment_status === "unpaid") {
      paymentLinkItems.push({
        kind: "action",
        key: "generate-link",
        label: "Generate payment link",
        onSelect: handlers.onGenerateLink,
      });
    } else if (lineItem.payment_status === "link_generated") {
      paymentLinkItems.push({
        kind: "action",
        key: "regenerate-link",
        label: "Regenerate payment link",
        onSelect: handlers.onGenerateLink,
      });
    }
    // "Copy payment link" only when a URL is currently in component state
    // (i.e. one was just generated and the popover is open / dismissable).
    if (pendingUrl) {
      paymentLinkItems.push({
        kind: "action",
        key: "copy-link",
        label: "Copy payment link",
        onSelect: handlers.onCopyLink,
      });
    }
  }

  // ── Payment-status transitions group ───────────────────────────────────────
  // Mirrors ALLOWED_MANUAL_TRANSITIONS in src/lib/payments/state.ts.
  // Refunded is terminal: a single disabled item.
  const statusItems: MenuItem[] = [];
  switch (lineItem.payment_status) {
    case "unpaid":
      statusItems.push({
        kind: "action",
        key: "mark-paid",
        label: "Mark as paid…",
        onSelect: handlers.onMarkAsPaid,
      });
      break;
    case "paid":
      statusItems.push({
        kind: "action",
        key: "mark-unpaid",
        label: "Mark as unpaid",
        onSelect: handlers.onMarkAsUnpaid,
      });
      statusItems.push({
        kind: "action",
        key: "mark-refunded",
        label: "Mark as refunded…",
        onSelect: handlers.onMarkAsRefunded,
      });
      break;
    case "failed":
      statusItems.push({
        kind: "action",
        key: "mark-paid",
        label: "Mark as paid…",
        onSelect: handlers.onMarkAsPaid,
      });
      break;
    case "link_generated":
      statusItems.push({
        kind: "action",
        key: "mark-paid",
        label: "Mark as paid…",
        onSelect: handlers.onMarkAsPaid,
      });
      statusItems.push({
        kind: "action",
        key: "cancel-link",
        label: "Cancel pending link",
        onSelect: handlers.onCancelLink,
      });
      statusItems.push({
        kind: "action",
        key: "mark-failed",
        label: "Mark as failed",
        onSelect: handlers.onMarkAsFailed,
      });
      break;
    case "refunded":
      statusItems.push({
        kind: "action",
        key: "no-actions",
        label: "No further status changes available",
        disabled: true,
        onSelect: () => {},
      });
      break;
  }

  // Merge groups with separators between them.
  const paymentGroup = [...paymentLinkItems, ...statusItems];
  if (paymentGroup.length > 0) {
    if (hasSourceGroup) {
      items.push({ kind: "separator", key: "sep-source-payment" });
    }
    items.push(...paymentGroup);
  }

  // ── PDF3 (#205) — Download bill (PDF) ──────────────────────────────────────
  // Always visible (including terminal/refunded rows — refunded bills still
  // want a paper trail). MenuItem kind: "action" so the host can run the
  // probe-then-anchor flow; "link" would render via Next.js <Link> and
  // intercept the PDF response client-side.
  if (items.length > 0) {
    items.push({ kind: "separator", key: "sep-download" });
  }
  items.push({
    kind: "action",
    key: "download-pdf",
    label: "Download bill (PDF)",
    onSelect: handlers.onDownloadPdf,
  });

  // ── View links ─────────────────────────────────────────────────────────────
  if (items.length > 0) {
    items.push({ kind: "separator", key: "sep-payment-links" });
  }

  items.push({
    kind: "link",
    key: "view-household",
    label: "View household",
    href: `/microgrids/${microgridId}/setup/households/${household.id}`,
  });

  items.push({
    kind: "link",
    key: "view-history",
    label: "View history",
    href: `/microgrids/${microgridId}/billing/${period.id}/history?household_id=${household.id}`,
  });

  return items;
}

// ── Component ─────────────────────────────────────────────────────────────────

const STUB_BANNER_DURATION_MS = 4000;
const IPN_AUTO_CLOSE_BANNER_DURATION_MS = 5000;
const ERROR_BANNER_DURATION_MS = 8000;
const ERROR_RETRY_BANNER_DURATION_MS = 8000;

export function RowActionsMenu(props: RowActionsMenuProps) {
  const {
    microgridId,
    lineItem,
    household,
    period,
    edgeAvailable,
    isPaymentConfigured,
    onRowBanner,
    onRequestRegenerate,
    onRequestSwitchToManual,
  } = props;

  const [optimisticStatus, setOptimisticStatus] =
    React.useState<BillingLineItemPaymentStatus>(lineItem.payment_status);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [pendingUrl, setPendingUrl] = React.useState<string | null>(null);

  // Confirm dialogs — three flavours:
  //   markPaidOpen / markRefundedOpen → notes-textarea variant
  //   cancelLinkOpen / markFailedOpen → plain neutral confirm
  const [markPaidOpen, setMarkPaidOpen] = React.useState(false);
  const [markRefundedOpen, setMarkRefundedOpen] = React.useState(false);
  const [cancelLinkOpen, setCancelLinkOpen] = React.useState(false);
  const [markFailedOpen, setMarkFailedOpen] = React.useState(false);

  // Sync optimistic status with the prop (server-confirmed value after
  // router.refresh() — see IPN auto-close note below).
  React.useEffect(() => {
    setOptimisticStatus(lineItem.payment_status);
  }, [lineItem.payment_status]);

  // ── IPN auto-close ────────────────────────────────────────────────────────
  // Track the previous payment_status. When the prop changes (parent polls,
  // calls router.refresh(), the server component re-renders) AND the menu
  // is open, close the menu and push an info banner. The first render
  // seeds the ref without firing — only subsequent changes trigger.
  const prevStatusRef = React.useRef<BillingLineItemPaymentStatus | undefined>(
    undefined,
  );
  React.useEffect(() => {
    if (
      prevStatusRef.current !== undefined &&
      prevStatusRef.current !== lineItem.payment_status &&
      menuOpen
    ) {
      setMenuOpen(false);
      onRowBanner({
        id: `${lineItem.id}-ipn-${Date.now()}`,
        lineItemId: lineItem.id,
        tone: "info",
        message: "Status updated by payment provider — menu refreshed.",
        durationMs: IPN_AUTO_CLOSE_BANNER_DURATION_MS,
      });
    }
    prevStatusRef.current = lineItem.payment_status;
    // We deliberately read menuOpen + onRowBanner + lineItem.id without
    // listing them as deps — the effect should fire ONLY when the status
    // prop changes. Including menuOpen would re-fire the effect every time
    // the menu opens, double-firing the auto-close on the next status
    // change. The eslint suppression below is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lineItem.payment_status]);

  // ── PATCH helpers ─────────────────────────────────────────────────────────
  // PATCH the payment-status route, optimistically flipping the chip and
  // reverting on failure. The error path pushes a row-level destructive
  // banner via onRowBanner so the operator sees what happened (the Banner
  // primitive carries role="alert" for destructive tone).
  const patchStatus = React.useCallback(
    async (
      newStatus: BillingLineItemPaymentStatus,
      notesValue: string | null,
    ): Promise<void> => {
      const prev = optimisticStatus;
      setOptimisticStatus(newStatus);

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
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
          };
          setOptimisticStatus(prev);
          onRowBanner({
            id: `${lineItem.id}-status-err-${Date.now()}`,
            lineItemId: lineItem.id,
            tone: "destructive",
            message: body.error ?? "Failed to update payment status.",
            durationMs: ERROR_BANNER_DURATION_MS,
          });
          // Throw so the ConfirmDialog inline retry surface lights up.
          throw new Error(body.error ?? "Failed to update payment status.");
        }
      } catch (err) {
        // Network error path — guard against re-throwing the same error
        // we already pushed to the banner above.
        if (err instanceof Error && err.message.includes("Failed to update")) {
          throw err;
        }
        setOptimisticStatus(prev);
        onRowBanner({
          id: `${lineItem.id}-status-net-${Date.now()}`,
          lineItemId: lineItem.id,
          tone: "destructive",
          message: "Network error. Please try again.",
          durationMs: ERROR_BANNER_DURATION_MS,
        });
        throw err;
      }
    },
    [lineItem.id, onRowBanner, optimisticStatus],
  );

  // ── Payment-link generation ───────────────────────────────────────────────
  const generatePaymentLink = React.useCallback(async () => {
    try {
      const res = await fetch(
        `/api/billing-line-items/${lineItem.id}/url`,
        { method: "POST" },
      );
      if (!res.ok) {
        pushPaymentLinkError();
        return;
      }
      const data = (await res.json()) as {
        redirectUrl: string;
        orderTrackingId: string;
        merchantReference: string;
      };
      setPendingUrl(data.redirectUrl);
    } catch {
      pushPaymentLinkError();
    }
    function pushPaymentLinkError() {
      onRowBanner({
        id: `${lineItem.id}-link-err-${Date.now()}`,
        lineItemId: lineItem.id,
        tone: "destructive",
        message: "Failed to generate payment link.",
        action: {
          label: "Retry",
          onClick: () => void generatePaymentLink(),
        },
        durationMs: ERROR_RETRY_BANNER_DURATION_MS,
      });
    }
  }, [lineItem.id, onRowBanner]);

  const copyPaymentLink = React.useCallback(() => {
    if (!pendingUrl) return;
    navigator.clipboard?.writeText(pendingUrl).catch(() => {});
  }, [pendingUrl]);

  // ── Stub handlers for BC3-owned actions ───────────────────────────────────
  const handleRegenerate = React.useCallback(
    (mode: "edge" | "manual") => {
      if (onRequestRegenerate) {
        onRequestRegenerate(mode);
        return;
      }
      onRowBanner({
        id: `${lineItem.id}-regen-stub-${Date.now()}`,
        lineItemId: lineItem.id,
        tone: "info",
        message: "Regenerate flow ships with BC3.",
        durationMs: STUB_BANNER_DURATION_MS,
      });
    },
    [lineItem.id, onRequestRegenerate, onRowBanner],
  );

  const handleSwitchToManual = React.useCallback(() => {
    if (onRequestSwitchToManual) {
      onRequestSwitchToManual();
      return;
    }
    onRowBanner({
      id: `${lineItem.id}-switch-stub-${Date.now()}`,
      lineItemId: lineItem.id,
      tone: "info",
      message: "Regenerate flow ships with BC3.",
      durationMs: STUB_BANNER_DURATION_MS,
    });
  }, [lineItem.id, onRequestSwitchToManual, onRowBanner]);

  // ── PDF3 (#205) — Download bill (PDF) ─────────────────────────────────────
  //
  // Probe-then-anchor pattern. Why probe first:
  //   - A 422 response body is `{ error, reason }` JSON. If we let an anchor
  //     fire directly, the browser would surface its native error page
  //     instead of letting us push a row banner with the upstream reason.
  //   - The route's `Content-Disposition: attachment` header is the
  //     cross-browser source of truth for the filename — so the second hit
  //     uses a fresh GET via a hidden <a>, NOT a blob URL.
  //   - The double-hit is fine: PDF1a's ensurePaymentLinkForLineItem() is
  //     idempotent, and the invoice_number first-render persistence already
  //     happened on the probe.
  const handleDownloadPdf = React.useCallback(async () => {
    const pdfUrl = `/api/billing-line-items/${lineItem.id}/pdf`;
    try {
      const res = await fetch(pdfUrl, { method: "GET" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        const msg =
          res.status === 403
            ? "Not authorized to download this bill."
            : res.status >= 500
              ? "Server error. Please retry."
              : `Cannot generate bill: ${body.reason ?? body.error ?? "unknown error"}`;
        onRowBanner({
          id: `${lineItem.id}-pdf-err-${Date.now()}`,
          lineItemId: lineItem.id,
          tone: "destructive",
          message: msg,
          durationMs: ERROR_BANNER_DURATION_MS,
        });
        return;
      }
      // Trigger a fresh GET via a hidden anchor — no `download` attribute,
      // so the route's `Content-Disposition: attachment; filename="…"`
      // drives the filename across all browsers.
      const a = document.createElement("a");
      a.href = pdfUrl;
      a.target = "_self";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      onRowBanner({
        id: `${lineItem.id}-pdf-net-${Date.now()}`,
        lineItemId: lineItem.id,
        tone: "destructive",
        message: "Network error. Please retry.",
        durationMs: ERROR_BANNER_DURATION_MS,
      });
    }
  }, [lineItem.id, onRowBanner]);

  // ── Compute menu items (memoised) ─────────────────────────────────────────
  const items = React.useMemo(
    () =>
      computeMenuItems({
        microgridId,
        lineItem: { ...lineItem, payment_status: optimisticStatus },
        household,
        period,
        edgeAvailable,
        isPaymentConfigured,
        pendingUrl,
        handlers: {
          onRequestRegenerate: handleRegenerate,
          onRequestSwitchToManual: handleSwitchToManual,
          onGenerateLink: () => void generatePaymentLink(),
          onCopyLink: copyPaymentLink,
          onMarkAsPaid: () => setMarkPaidOpen(true),
          onMarkAsRefunded: () => setMarkRefundedOpen(true),
          onMarkAsUnpaid: () => void patchStatus("unpaid", null),
          onCancelLink: () => setCancelLinkOpen(true),
          onMarkAsFailed: () => setMarkFailedOpen(true),
          // PDF3 (#205) — fire the probe-then-anchor download flow.
          onDownloadPdf: () => void handleDownloadPdf(),
        },
      }),
    [
      microgridId,
      lineItem,
      optimisticStatus,
      household,
      period,
      edgeAvailable,
      isPaymentConfigured,
      pendingUrl,
      handleRegenerate,
      handleSwitchToManual,
      generatePaymentLink,
      copyPaymentLink,
      patchStatus,
      handleDownloadPdf,
    ],
  );

  // Period label for the confirm dialogs.
  const periodLabel =
    period.start_date === period.end_date
      ? period.start_date
      : `${period.start_date} – ${period.end_date}`;

  return (
    <span className="inline-flex items-center gap-1.5">
      {/* Source chip — display-only */}
      <StatusChip
        kind="billingLineItemReadingSource"
        status={lineItem.reading_source}
      />

      {/* Status chip — display-only (NOT a click target). */}
      <StatusChip
        kind="billingLineItemPaymentStatus"
        status={optimisticStatus}
      />

      {/* Kebab + dropdown */}
      <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Row actions for ${household.display_name}`}
            aria-haspopup="menu"
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <KebabIcon />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className={cn(
              "z-50 min-w-[220px] overflow-hidden rounded-md border border-border bg-card p-1 shadow-elev-3",
              "data-[state=open]:animate-in data-[state=closed]:animate-out",
              "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
              "data-[state=open]:zoom-in-95 data-[state=closed]:zoom-out-95",
            )}
          >
            {items.map((item) => {
              if (item.kind === "separator") {
                return (
                  <DropdownMenu.Separator
                    key={item.key}
                    className="my-1 h-px bg-border"
                  />
                );
              }
              if (item.kind === "link") {
                return (
                  <DropdownMenu.Item key={item.key} asChild>
                    <Link
                      href={item.href}
                      className="flex cursor-pointer select-none items-center rounded-sm px-2 py-1.5 text-[13px] text-foreground outline-none data-[highlighted]:bg-muted"
                    >
                      {item.label}
                    </Link>
                  </DropdownMenu.Item>
                );
              }
              // kind === "action"
              if (item.disabled) {
                return (
                  <DropdownMenu.Item
                    key={item.key}
                    disabled
                    className="flex cursor-not-allowed select-none items-center rounded-sm px-2 py-1.5 text-[13px] text-muted-foreground outline-none"
                  >
                    {item.label}
                  </DropdownMenu.Item>
                );
              }
              return (
                <DropdownMenu.Item
                  key={item.key}
                  onSelect={() => item.onSelect()}
                  className={cn(
                    "flex cursor-pointer select-none flex-col items-start rounded-sm px-2 py-1.5 text-[13px] text-foreground outline-none",
                    "data-[highlighted]:bg-muted",
                  )}
                >
                  <span className="flex w-full items-center">
                    <span className="flex-1">
                      {item.warning ? "⚠ " : ""}
                      {item.label}
                    </span>
                  </span>
                  {item.subtext && (
                    <span className="text-[11px] text-muted-foreground">
                      {item.subtext}
                    </span>
                  )}
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>

      {/* Payment-link popover — anchored next to the kebab. */}
      <PaymentLinkPopover url={pendingUrl} onClose={() => setPendingUrl(null)} />

      {/* "Mark as paid…" — notes textarea variant */}
      <PaymentNotesConfirmDialog
        open={markPaidOpen}
        onOpenChange={setMarkPaidOpen}
        title="Mark this bill as paid"
        confirmLabel="Mark as paid"
        householdName={household.display_name}
        periodLabel={periodLabel}
        totalAmount={lineItem.total_amount}
        onConfirm={(notes) => patchStatus("paid", notes || null)}
      />

      {/* "Mark as refunded…" — notes textarea variant */}
      <PaymentNotesConfirmDialog
        open={markRefundedOpen}
        onOpenChange={setMarkRefundedOpen}
        title="Mark this bill as refunded"
        confirmLabel="Mark as refunded"
        householdName={household.display_name}
        periodLabel={periodLabel}
        totalAmount={lineItem.total_amount}
        onConfirm={(notes) => patchStatus("refunded", notes || null)}
      />

      {/* "Cancel pending link" — plain neutral confirm, no notes */}
      <ConfirmDialog
        open={cancelLinkOpen}
        onOpenChange={setCancelLinkOpen}
        title="Cancel pending payment link?"
        description={`Cancel the payment link for ${household.display_name}? They'll need a new link to pay.`}
        confirmLabel="Cancel link"
        tone="neutral"
        onConfirm={() => patchStatus("unpaid", null)}
      />

      {/* "Mark as failed" — plain neutral confirm, no notes */}
      <ConfirmDialog
        open={markFailedOpen}
        onOpenChange={setMarkFailedOpen}
        title="Mark this bill as failed?"
        description={`Mark the payment for ${household.display_name} as failed.`}
        confirmLabel="Mark as failed"
        tone="neutral"
        onConfirm={() => patchStatus("failed", null)}
      />
    </span>
  );
}

function KebabIcon() {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <circle cx="8" cy="3" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="8" cy="13" r="1.25" />
    </svg>
  );
}
