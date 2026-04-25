"use client";

// RowBannerStack — per-row transient-banner slot (BC2 #174 AC7).
//
// Rendered as a sibling of the existing `rowErrors` <ul> in
// `<BillingTable>` — OUTSIDE the CopyTable <table> markup. CopyTable's
// grid cannot host arbitrary <tr> children, so per-row transient errors
// (payment-link failures, BC3 regenerate stub messages, IPN auto-close
// info messages) surface here instead of inline in the row.
//
// Each entry renders as a `<Banner>`. Auto-dismiss after `durationMs`;
// manual dismiss via the close button. Multiple entries for the same
// line item stack vertically.

import * as React from "react";
import { Banner, type BannerTone } from "@/components/ui/banner";

export interface RowBannerEntry {
  /** Stable id for React keys + dismissal; caller-supplied (uuid or counter). */
  id: string;
  /** The billing_line_items.id this entry belongs to (used for the prefix). */
  lineItemId: string;
  /** Banner tone — currently used: 'info' (IPN auto-close, BC3 stubs)
   *  and 'destructive' (payment-link failure with Retry). */
  tone: Extract<BannerTone, "info" | "destructive">;
  /** Body text. The household-name prefix is added by the stack. */
  message: string;
  /** Optional action — surfaces as a button in the banner footer. */
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss timeout in ms. Pass `0` to disable auto-dismiss. */
  durationMs: number;
}

export interface RowBannerStackProps {
  entries: RowBannerEntry[];
  onDismiss: (id: string) => void;
  /**
   * Resolves a household display name from a line-item id. Returns
   * `undefined` when the line item is unknown (e.g. stale entry after a
   * row was removed). The stack falls back to a bare message in that case.
   */
  getHouseholdName: (lineItemId: string) => string | undefined;
}

export function RowBannerStack({
  entries,
  onDismiss,
  getHouseholdName,
}: RowBannerStackProps) {
  if (entries.length === 0) return null;

  return (
    <div className="space-y-2" data-testid="row-banner-stack">
      {entries.map((entry) => (
        <RowBannerItem
          key={entry.id}
          entry={entry}
          householdName={getHouseholdName(entry.lineItemId)}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}

function RowBannerItem({
  entry,
  householdName,
  onDismiss,
}: {
  entry: RowBannerEntry;
  householdName: string | undefined;
  onDismiss: (id: string) => void;
}) {
  // Auto-dismiss timer — runs once per entry mount; the parent's setter
  // changes the entries array reference when dismissed, which unmounts
  // this component and clears the timer.
  React.useEffect(() => {
    if (entry.durationMs <= 0) return;
    const timer = setTimeout(() => {
      onDismiss(entry.id);
    }, entry.durationMs);
    return () => clearTimeout(timer);
  }, [entry.id, entry.durationMs, onDismiss]);

  // Title: household-name prefix + a tone-appropriate label.
  // Banners use the title as their headline; we keep the household name
  // in the title so the alert is announceable for screen readers.
  const titlePrefix = householdName ? `${householdName} · ` : "";
  const title =
    entry.tone === "destructive"
      ? `${titlePrefix}${entry.message}`
      : `${titlePrefix}${entry.message}`;

  return (
    <Banner
      tone={entry.tone}
      title={title}
      action={
        <div className="flex items-center gap-2">
          {entry.action && (
            <button
              type="button"
              onClick={entry.action.onClick}
              className="text-sm font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {entry.action.label}
            </button>
          )}
          <button
            type="button"
            onClick={() => onDismiss(entry.id)}
            className="text-sm font-medium underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Dismiss notification for ${householdName ?? "row"}`}
          >
            Dismiss
          </button>
        </div>
      }
    >
      {/* Body intentionally empty — title carries the message so it is
          announced via role=alert/status. The action row holds the
          interactive controls. */}
      <span className="sr-only">{entry.message}</span>
    </Banner>
  );
}
