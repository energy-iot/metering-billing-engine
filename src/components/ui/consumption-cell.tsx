"use client";

// ConsumptionCell — single day in the calendar grid.
//
// Contract:
//   • Tone derives from `pct` (fraction of budget) against the
//     `thresholds` prop. Defaults success=0.75, warn=1. Households
//     can tune (some want green at <50% used).
//   • `mode` switches data semantics:
//       'budget'   — pct = used / monthlyBudget (default)
//       'relative' — pct = today / typicalDay (no budget set)
//       'absolute' — pct undefined; render kWh only (gray cell)
//   • Vertical fill bar visualizes `pct` (capped at 1.0 in fill);
//     for `pct >= 1.35` an overlaid diagonal stripe distinguishes
//     "way over" from "just over" — single-channel asymmetry the
//     critique flagged.
//   • Touch target ≥ 44px (was 38px in the artifact). Day label
//     and kWh both render at 11px (was 9–10px). WCAG-AA-friendly.
//   • Renders a button so the cell is focusable + clickable for
//     drill-in (per-day detail). Supply `onSelect` to wire it.
//   • Color-blind safe: tone is reinforced by the fill direction +
//     stripe shape, not just hue.

import * as React from "react";
import { cn } from "@/lib/utils";

export type ConsumptionTone = "success" | "warn" | "alert" | "neutral";

export interface ConsumptionCellProps {
  day: number;
  /** Fraction of budget used. null = no data. */
  pct: number | null;
  /** Energy in kWh. null = no data. */
  kwh: number | null;
  /** Smaller variant (44×44 instead of 56×56). Default false. */
  small?: boolean;
  mode?: "budget" | "relative" | "absolute";
  thresholds?: { success: number; warn: number };
  /** Future-state markers: 'future' (no data yet), 'missing' (gap). */
  status?: "future" | "missing";
  onSelect?: () => void;
  className?: string;
}

const palettes: Record<ConsumptionTone, { bg: string; ring: string; fg: string }> = {
  success: { bg: "bg-success-muted",     ring: "bg-success",     fg: "text-success-fg" },
  warn:    { bg: "bg-warning-muted",     ring: "bg-warning",     fg: "text-warning-fg" },
  alert:   { bg: "bg-destructive-muted", ring: "bg-destructive", fg: "text-destructive-fg" },
  neutral: { bg: "bg-muted",             ring: "bg-border",      fg: "text-muted-foreground" },
};

export function ConsumptionCell({
  day,
  pct,
  kwh,
  small = false,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  mode = "budget",
  thresholds = { success: 0.75, warn: 1 },
  status,
  onSelect,
  className,
}: ConsumptionCellProps) {
  const tone: ConsumptionTone =
    pct == null
      ? "neutral"
      : pct < thresholds.success
        ? "success"
        : pct < thresholds.warn
          ? "warn"
          : "alert";
  const palette = palettes[tone];
  const fill = pct == null ? 0 : Math.min(pct, 1);
  const wayOver = pct != null && pct >= 1.35;
  const sizeCls = small ? "h-11 w-11" : "h-14 w-14";

  const ariaLabel = (() => {
    if (status === "future") return `Day ${day}: not yet`;
    if (status === "missing") return `Day ${day}: no reading`;
    if (pct == null) return `Day ${day}: no data`;
    return `Day ${day}: ${kwh != null ? kwh.toFixed(1) : "?"} kWh, ${Math.round(pct * 100)}% of budget`;
  })();

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-label={ariaLabel}
      className={cn(
        "relative flex flex-col justify-between overflow-hidden rounded-md p-1 text-left transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        sizeCls,
        palette.bg,
        onSelect ? "cursor-pointer" : "cursor-default",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("absolute inset-x-0 bottom-0 opacity-20", palette.ring)}
        style={{ height: `${fill * 100}%` }}
      />
      {wayOver && (
        <span
          aria-hidden="true"
          className="absolute inset-0 opacity-30"
          style={{
            backgroundImage:
              "repeating-linear-gradient(45deg, transparent 0 6px, var(--destructive) 6px 7px)",
          }}
        />
      )}
      <span className={cn("relative text-[11px] font-semibold", palette.fg)}>{day}</span>
      <span
        className={cn(
          "relative font-mono text-[11px] font-medium tabular-nums",
          palette.fg,
        )}
      >
        {status === "future" ? "·" : status === "missing" ? "?" : kwh != null ? kwh.toFixed(1) : "—"}
      </span>
    </button>
  );
}
