"use client";

/**
 * ManualUsageCell — inline-editable kWh cell for un-metered (manual-billing)
 * billing line items. Used in BillingTable for the END (kWh) and USAGE (kWh)
 * columns when `lineItem.device_id == null`.
 *
 * Spec (#158 AC-6 + AC-7):
 *   - Renders as a `<input type="number" step="0.001" min="0">` styled to
 *     look like a copy-cell when not focused (right-aligned monospace,
 *     subtle hover outline).
 *   - Save semantics: blur OR Enter fires PATCH /api/billing-line-items/
 *     [lineItemId]/usage. Esc reverts and unfocuses.
 *   - Optimistic UI: the local value updates on blur/Enter; spinner shows
 *     in-flight. On 200, router.refresh() reconciles. On error, the cell
 *     reverts AND a row-level error message renders below the row (caller's
 *     responsibility — this component surfaces the error via `onError`).
 *   - Validation: empty input reverts without saving. Negative or
 *     non-numeric → don't fire PATCH; instead surface "Must be a non-
 *     negative number" via `onError`.
 *   - The route recomputes tier_breakdown + total_amount server-side via
 *     calculateTieredCost; this component just hands off the new value.
 *
 * Read-only fallback: when `editable={false}`, renders a plain right-
 * aligned span matching the copy-cell visual style. This keeps metered-row
 * cells visually identical to the rest of the BillingTable.
 *
 * BC3 (#175 AC1): The cell's `editable` prop is computed by `BillingTable`
 * as `(item.device_id === null || switchedToManual.has(item.id)) && isDraft`.
 * Closed periods are EXCLUDED — the PATCH route hard-rejects with 409
 * `period_closed`, and closed-period manual edits go through
 * `<RegenerateRowDialog mode="manual">` which uses /api/billing/generate.
 * The cell's PATCH call surface is unchanged.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export type ManualUsageField = "end_kwh" | "usage_kwh";

export interface ManualUsageCellProps {
  /** The billing_line_items.id to patch. */
  lineItemId: string;
  /** Which numeric field this cell represents — sent in the PATCH body. */
  field: ManualUsageField;
  /** Current persisted value (null when un-entered). */
  value: number | null;
  /** Format function used for the display state (matches BillingTable). */
  format: (v: number | null) => string;
  /** When false, cell renders as read-only (used for metered rows). */
  editable: boolean;
  /** Caller fires `router.refresh()` already on success; this lets the parent
   *  surface row-level errors below the table row. */
  onError?: (lineItemId: string, message: string | null) => void;
  /** Tailwind classes appended to the rendered element. */
  className?: string;
}

/**
 * Parse a number input string. Returns:
 *   - { ok: true, value: number } on success
 *   - { ok: false, reason: 'empty' | 'invalid' | 'negative' } on rejection
 */
function parseInput(raw: string):
  | { ok: true; value: number }
  | { ok: false; reason: "empty" | "invalid" | "negative" } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return { ok: false, reason: "invalid" };
  if (n < 0) return { ok: false, reason: "negative" };
  return { ok: true, value: n };
}

export function ManualUsageCell({
  lineItemId,
  field,
  value,
  format,
  editable,
  onError,
  className,
}: ManualUsageCellProps) {
  const router = useRouter();
  const [draft, setDraft] = React.useState<string>(
    value == null ? "" : String(value)
  );
  const [saving, setSaving] = React.useState(false);

  // Re-sync the draft whenever the persisted value changes (e.g. after
  // router.refresh() pulls a new server-confirmed number).
  React.useEffect(() => {
    setDraft(value == null ? "" : String(value));
  }, [value]);

  // Read-only path — match the surrounding CopyTable visual (right-aligned
  // monospace) so metered rows render identically to before.
  if (!editable) {
    return (
      <span
        className={cn(
          "inline-block w-full text-right font-mono text-[12px] tabular-nums",
          className
        )}
      >
        {format(value)}
      </span>
    );
  }

  async function commit(rawCandidate: string): Promise<void> {
    const parsed = parseInput(rawCandidate);
    if (!parsed.ok) {
      if (parsed.reason === "empty") {
        // Empty input: revert silently to the persisted value, no save fire.
        setDraft(value == null ? "" : String(value));
        onError?.(lineItemId, null);
        return;
      }
      if (parsed.reason === "negative" || parsed.reason === "invalid") {
        onError?.(lineItemId, "Must be a non-negative number");
        return;
      }
    }
    if (!parsed.ok) return;

    // Only PATCH when the value actually changed.
    if (parsed.value === value) {
      onError?.(lineItemId, null);
      return;
    }

    setSaving(true);
    try {
      const res = await fetch(
        `/api/billing-line-items/${lineItemId}/usage`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: parsed.value }),
        }
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          reason?: string;
        };
        // Revert local draft to the persisted value.
        setDraft(value == null ? "" : String(value));
        onError?.(
          lineItemId,
          body.error ?? `Could not save (HTTP ${res.status}).`
        );
        setSaving(false);
        return;
      }
      onError?.(lineItemId, null);
      setSaving(false);
      router.refresh();
    } catch (err) {
      setDraft(value == null ? "" : String(value));
      onError?.(
        lineItemId,
        err instanceof Error ? err.message : "Network error. Please retry."
      );
      setSaving(false);
    }
  }

  return (
    <span className={cn("relative inline-flex w-full items-center justify-end", className)}>
      <input
        type="number"
        step="0.001"
        min="0"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          // Blur-to-save. If the value didn't change, commit() will short-
          // circuit before firing the PATCH.
          void commit(draft);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.currentTarget as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            e.preventDefault();
            // Revert to the persisted value and unfocus.
            setDraft(value == null ? "" : String(value));
            onError?.(lineItemId, null);
            (e.currentTarget as HTMLInputElement).blur();
          }
        }}
        disabled={saving}
        aria-label={`${field === "end_kwh" ? "End kWh" : "Usage kWh"} for line item ${lineItemId}`}
        className={cn(
          "w-full bg-transparent text-right font-mono text-[12px] tabular-nums",
          "rounded-sm px-1 py-0.5 outline-none",
          "hover:ring-1 hover:ring-border focus:ring-2 focus:ring-ring",
          "disabled:opacity-60",
        )}
      />
      {saving && (
        <span
          aria-hidden="true"
          className="ml-1 inline-block h-3 w-3 animate-spin rounded-full border border-border border-t-transparent"
        />
      )}
    </span>
  );
}
