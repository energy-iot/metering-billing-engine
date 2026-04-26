"use client";

/**
 * StickySelectionBar — sticky bottom action bar shown when ≥1 row is
 * selected via the multi-select checkboxes (BC3 #175 AC3).
 *
 * Mounted as a SIBLING at the END of the BillingTable container so
 * document-flow layering is unambiguous (no z-index collision with
 * paidToasts which render inline above the table). When `disabled`,
 * the regenerate button is non-clickable and gets a tooltip — see
 * AC6 for the closed-period gating copy.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export interface StickySelectionBarProps {
  visibleCount: number;
  selectedCount: number;
  onRegenerate: () => void;
  onClear: () => void;
  /** When true, regenerate is disabled (e.g. closed period); pass tooltip via `disabledTooltip`. */
  disabled?: boolean;
  disabledTooltip?: string;
}

export function StickySelectionBar(props: StickySelectionBarProps) {
  const {
    selectedCount,
    onRegenerate,
    onClear,
    disabled = false,
    disabledTooltip,
  } = props;

  if (selectedCount === 0) return null;

  return (
    <div
      data-testid="sticky-selection-bar"
      role="region"
      aria-label="Selected rows actions"
      className={cn(
        "sticky bottom-0 z-10",
        "flex items-center justify-between gap-3 rounded-md border border-border bg-card p-3 shadow-md",
      )}
    >
      <span className="text-[13px] font-medium text-foreground">
        {selectedCount} selected
      </span>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onRegenerate}
          disabled={disabled}
          title={disabled ? disabledTooltip : undefined}
          className={cn(
            "inline-flex h-8 items-center rounded-md border border-primary bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-60",
          )}
        >
          Regenerate selected
        </button>
        <button
          type="button"
          onClick={onClear}
          className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Clear selection
        </button>
      </div>
    </div>
  );
}
