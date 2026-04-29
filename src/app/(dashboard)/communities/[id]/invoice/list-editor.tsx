"use client";

/**
 * list-editor.tsx — Generic add/remove + up/down reorder editor (#204 / PDF2).
 *
 * Used by the Tax IDs section (label/value pair rows, max 4) and the Address
 * Lines section (single string rows, max 6). The renderProp pattern keeps
 * row markup at the call site — the editor only owns the array shape +
 * controls.
 *
 * A11y:
 *   - Each row controls (Up/Down/Remove) are real `<button>` elements with
 *     visible labels on the focused state.
 *   - Disabled at boundaries (Up at row 0, Down at last row).
 *   - The Add button is disabled at the max-rows guard.
 *
 * Out of scope (refinement R5): drag-and-drop reorder. At N≤6 the up/down
 * arrows are sufficient and have full keyboard support.
 */

import * as React from "react";
import { cn } from "@/lib/utils";

export type ListEditorProps<T> = {
  rows: T[];
  onChange: (next: T[]) => void;
  /** Render the editable controls for a single row. */
  renderRow: (row: T, index: number, update: (next: T) => void) => React.ReactNode;
  /** Build a fresh empty row when the operator clicks "Add". */
  emptyRow: () => T;
  /** Maximum number of rows the editor will allow (inclusive). */
  maxRows: number;
  /** Singular label for the Add button (e.g. "Add tax ID"). */
  addLabel: string;
  /** Optional empty-state copy when the list has zero rows. */
  emptyCopy?: string;
};

export function ListEditor<T>({
  rows,
  onChange,
  renderRow,
  emptyRow,
  maxRows,
  addLabel,
  emptyCopy,
}: ListEditorProps<T>) {
  function handleAdd() {
    if (rows.length >= maxRows) return;
    onChange([...rows, emptyRow()]);
  }

  function handleRemove(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  function handleMove(index: number, direction: "up" | "down") {
    const swap = direction === "up" ? index - 1 : index + 1;
    if (swap < 0 || swap >= rows.length) return;
    const next = [...rows];
    [next[index], next[swap]] = [next[swap], next[index]];
    onChange(next);
  }

  function handleUpdate(index: number, value: T) {
    const next = [...rows];
    next[index] = value;
    onChange(next);
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-2">
        {emptyCopy && (
          <p className="text-[11px] text-muted-foreground">{emptyCopy}</p>
        )}
        <button
          type="button"
          onClick={handleAdd}
          className="rounded-md border border-dashed border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
        >
          + {addLabel}
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {rows.map((row, i) => (
        <div
          key={i}
          className="flex items-start gap-2 rounded-md border border-border bg-card p-2"
        >
          <div className="flex-1">
            {renderRow(row, i, (next) => handleUpdate(i, next))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => handleMove(i, "up")}
              disabled={i === 0}
              aria-label={`Move row ${i + 1} up`}
              title="Move up"
              className={cn(
                "rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              ↑
            </button>
            <button
              type="button"
              onClick={() => handleMove(i, "down")}
              disabled={i === rows.length - 1}
              aria-label={`Move row ${i + 1} down`}
              title="Move down"
              className={cn(
                "rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground hover:bg-muted",
                "disabled:cursor-not-allowed disabled:opacity-40",
              )}
            >
              ↓
            </button>
            <button
              type="button"
              onClick={() => handleRemove(i)}
              aria-label={`Remove row ${i + 1}`}
              title="Remove"
              className="rounded-md border border-border bg-card px-2 py-1 text-xs text-destructive-fg hover:bg-destructive-muted"
            >
              ×
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        onClick={handleAdd}
        disabled={rows.length >= maxRows}
        className={cn(
          "rounded-md border border-dashed border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        + {addLabel}
      </button>
      {rows.length >= maxRows && (
        <p className="text-[11px] text-muted-foreground">
          Maximum of {maxRows} rows reached.
        </p>
      )}
    </div>
  );
}
