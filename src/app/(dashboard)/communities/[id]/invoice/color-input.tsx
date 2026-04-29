"use client";

/**
 * color-input.tsx — Native `<input type="color">` swatch + paired hex text
 * input (#204 / PDF2).
 *
 * Why a paired text input:
 *   - `<input type="color">` has spotty screen-reader support; the text input
 *     is the SR-accessible affordance.
 *   - Allows operators to paste a hex value from a brand guide.
 *
 * Bidirectional binding contract:
 *   - Typing a valid hex in the text input updates the swatch.
 *   - Picking a colour from the swatch updates the text input (lowercase).
 *
 * Sanitisation:
 *   - Internal value is always lowercase `#rrggbb`.
 *   - Whitespace is trimmed on text-input blur.
 *   - Invalid hex while typing renders the swatch with the previous valid
 *     value (the swatch falls back to `#000000` on a malformed `value`
 *     attribute, so we only forward a valid hex into it).
 *
 * Validation feedback is left to the parent shell — this primitive just
 * sanitises on blur and reports up via `onChange`.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

const HEX_RE = /^#[0-9a-f]{6}$/;

export type ColorInputProps = {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Default to fall back to when the user clears the input. */
  defaultValue: string;
  /** Optional helper text rendered below the input pair. */
  description?: string;
  disabled?: boolean;
};

export function ColorInput({
  id,
  label,
  value,
  onChange,
  defaultValue,
  description,
  disabled = false,
}: ColorInputProps) {
  // Local text-input state lets the operator type freely; we only push
  // sanitised values up to the parent.
  const [draft, setDraft] = React.useState(value);

  React.useEffect(() => {
    setDraft(value);
  }, [value]);

  const sanitisedSwatchValue = HEX_RE.test(value) ? value : defaultValue;

  function handleSwatchChange(e: React.ChangeEvent<HTMLInputElement>) {
    const next = e.target.value.toLowerCase();
    setDraft(next);
    onChange(next);
  }

  function handleTextChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDraft(e.target.value);
    // Only push up if the typed value is valid hex — otherwise the swatch
    // would silently reset to #000000 mid-typing.
    const candidate = e.target.value.trim().toLowerCase();
    if (HEX_RE.test(candidate)) {
      onChange(candidate);
    }
  }

  function handleTextBlur() {
    const candidate = draft.trim().toLowerCase();
    if (HEX_RE.test(candidate)) {
      setDraft(candidate);
      onChange(candidate);
    } else {
      // Invalid hex on blur — revert to the last valid value.
      setDraft(value);
    }
  }

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 block text-xs font-medium text-foreground"
      >
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={`${id}-swatch`}
          type="color"
          aria-label={`${label} colour swatch`}
          value={sanitisedSwatchValue}
          onChange={handleSwatchChange}
          disabled={disabled}
          className={cn(
            "h-9 w-12 cursor-pointer rounded-md border border-border bg-card",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
        <input
          id={id}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={handleTextChange}
          onBlur={handleTextBlur}
          disabled={disabled}
          aria-label={`${label} hex value`}
          className={cn(
            "flex h-9 w-32 rounded-md border border-border bg-card px-3 py-1 font-mono text-xs text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />
      </div>
      {description && (
        <p className="mt-1 text-[11px] text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
