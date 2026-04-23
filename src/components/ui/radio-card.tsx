"use client";

// RadioCard — project-specific composition layering RadioGroupItem into a styled card.
// Added in #71 (UX0 Shared UX-layer primitives). NOT a shadcn primitive — project-specific.
//
// Usage:
//   <RadioGroup value={selected} onValueChange={setSelected}>
//     <RadioCard value="opt-a" title="Option A" description="..." meta="..." />
//     <RadioCard value="opt-b" title="Option B" disabled />
//   </RadioGroup>

import * as React from "react";
import { cn } from "@/lib/utils";
import { RadioGroupItem } from "./radio-group";

export interface RadioCardProps {
  value: string;
  title: React.ReactNode;
  description?: React.ReactNode;
  meta?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
}

export const RadioCard = React.forwardRef<HTMLLabelElement, RadioCardProps>(
  function RadioCard(
    { value, title, description, meta, disabled = false, className, id },
    ref
  ) {
    const generatedId = React.useId();
    const resolvedId = id ?? generatedId;

    return (
      <label
        ref={ref}
        htmlFor={resolvedId}
        data-disabled={disabled ? "" : undefined}
        className={cn(
          // Base card layout
          "flex items-start gap-3 rounded-md border border-border bg-card p-4 cursor-pointer transition-colors",
          // Selected state — applied via Radix data attributes on the label's sibling item;
          // since the label wraps the item, we use has-[] selectors if available, but for
          // broad compat we rely on the RadioGroup parent to provide data-state via context.
          // The actual selected/unselected border + bg is toggled by the RadioGroupItem's
          // data-state="checked" propagating up via CSS. We expose both classes for test
          // assertions; the consumer controls value.
          "has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5",
          // Disabled state
          disabled && "opacity-50 cursor-not-allowed",
          // Focus-visible ring (applied via the inner RadioGroupItem focus)
          "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1",
          className
        )}
      >
        {/* The hidden-ish radio input — still accessible, positioned inside the label */}
        <RadioGroupItem
          id={resolvedId}
          value={value}
          disabled={disabled}
          className="mt-0.5 shrink-0"
        />

        {/* Card text content */}
        <div className="flex-1 min-w-0">
          {/* Title — bold */}
          <div className="text-sm font-semibold text-foreground leading-snug">
            {title}
          </div>

          {/* Description — muted */}
          {description !== undefined && (
            <div className="mt-0.5 text-sm text-muted-foreground leading-snug">
              {description}
            </div>
          )}

          {/* Meta — small monospace caption */}
          {meta !== undefined && (
            <div className="mt-1 font-mono text-xs text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
      </label>
    );
  }
);
