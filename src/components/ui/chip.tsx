// Chip — semantic status badge.
//
// Contract:
//   - Tones: neutral / success / warn / alert / brand. Each maps to
//     a (bg, fg, dot-color) triple defined ENTIRELY via tokens —
//     no baked oklch literals.
//   - States: default / loading / disabled / stale. (Hover ≡ default;
//     chips are passive. Focus is rendered as outline-ring when the
//     chip is interactive — caller wires the focus-ring class.)
//   - The dot is `aria-hidden`; the chip carries a semantic
//     `aria-label`. Pair labels with text — never color alone.
//   - Max width with truncation handles long labels like
//     "Disputed by household".
//   - Class names compose via `cn()` so callers can extend (e.g. add
//     `cursor-pointer` for clickable chips).

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const chipVariants = cva(
  // base — 11px UPPERCASE, pill radius, max-width with truncation.
  "inline-flex items-center gap-1.5 rounded-pill px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide leading-tight max-w-[14rem] truncate align-middle",
  {
    variants: {
      tone: {
        neutral: "bg-muted text-muted-foreground",
        success: "bg-success-muted text-success-fg",
        warn: "bg-warning-muted text-warning-fg",
        alert: "bg-destructive-muted text-destructive-fg",
        brand: "bg-accent text-accent-foreground",
      },
      size: {
        sm: "px-1.5 py-px text-[11px]",
        md: "",
      },
      state: {
        default: "",
        loading: "[&>span:first-child]:[animation:mbe-pulse_1.2s_ease-in-out_infinite]",
        disabled: "opacity-50 cursor-not-allowed",
        stale: "opacity-60 border border-dashed border-border",
      },
    },
    defaultVariants: { tone: "neutral", size: "md", state: "default" },
  },
);

export interface ChipProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children">,
    VariantProps<typeof chipVariants> {
  /** Render the leading status dot. */
  dot?: boolean;
  /** Required for non-decorative chips so screen readers get the meaning. */
  "aria-label"?: string;
  children: React.ReactNode;
}

const dotByTone: Record<NonNullable<ChipProps["tone"]>, string> = {
  neutral: "bg-muted-foreground",
  success: "bg-success",
  warn: "bg-warning",
  alert: "bg-destructive",
  brand: "bg-primary",
};

export const Chip = React.forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { className, tone, size, state, dot, children, ...props },
  ref,
) {
  return (
    <span ref={ref} className={cn(chipVariants({ tone, size, state }), className)} {...props}>
      {dot && (
        <span
          aria-hidden="true"
          className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotByTone[tone ?? "neutral"])}
        />
      )}
      {children}
    </span>
  );
});
