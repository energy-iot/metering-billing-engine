"use client";

/**
 * MultiSelectableCopyTable — wraps `<CopyTable>` with a leading checkbox
 * column for multi-select (BC3 #175 AC3).
 *
 * Rationale: CopyTable's keyboard-nav model is column-major and the action
 * columns it already supports are explicitly excluded from the nav grid.
 * Adding an interactive checkbox column INSIDE CopyTable would require
 * reworking the nav model. Cleaner to render the checkboxes in a sibling
 * `<table>` aligned by row-height with the CopyTable, OR (chosen approach)
 * compose by rendering a sticky-left column in the SAME table — using
 * CopyTable's `action` column kind. The action column is already nav-
 * excluded, so a checkbox there does NOT fight the keyboard model.
 *
 * Implementation: this component does not render `<CopyTable>` directly;
 * instead it returns a `ColumnDef<Row>` that the caller prepends to its
 * existing column list. That keeps the parent's CopyTable invocation as
 * the single source of truth and avoids JSX gymnastics.
 *
 * Header checkbox: tri-state (unchecked / checked / indeterminate) — sets
 * all/none of currently-rendered rows.
 */

import * as React from "react";
import type { ColumnDef } from "@/components/ui/copy-table";

export interface MultiSelectColumnArgs<Row> {
  /** Function that maps a row to its select-key (typically the household id). */
  getRowId: (row: Row) => string;
  /** Function that returns the display name for a row's aria-label. */
  getRowName: (row: Row) => string;
  /** Currently selected ids (parent-owned). */
  selectedIds: Set<string>;
  /** All ids visible in the table — used to compute tri-state header. */
  visibleIds: string[];
  /** Toggle a single row by id. */
  onToggleRow: (id: string) => void;
  /** Set the selection set wholesale (used by the header all/none toggle). */
  onSetAll: (ids: string[]) => void;
  /** Whether the column is hidden (e.g. when the pre-flight panel is open). */
  hidden?: boolean;
}

/**
 * Build the leading checkbox `ColumnDef` for `<CopyTable>`. Returns null
 * when `hidden` so the caller can skip the column entirely.
 */
export function buildMultiSelectColumn<Row>(
  args: MultiSelectColumnArgs<Row>,
): ColumnDef<Row> | null {
  const {
    getRowId,
    getRowName,
    selectedIds,
    visibleIds,
    onToggleRow,
    onSetAll,
    hidden,
  } = args;
  if (hidden) return null;

  const headerState: "checked" | "unchecked" | "indeterminate" =
    selectedIds.size === 0
      ? "unchecked"
      : selectedIds.size === visibleIds.length && visibleIds.length > 0
        ? "checked"
        : "indeterminate";

  return {
    kind: "action",
    header: "",
    ariaLabel: "Select rows",
    className: "w-8",
    render: (row: Row) => {
      const id = getRowId(row);
      const name = getRowName(row);
      const checked = selectedIds.has(id);
      return (
        <input
          type="checkbox"
          aria-label={`Select ${name}`}
          checked={checked}
          onChange={() => onToggleRow(id)}
          className="size-4 rounded border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      );
    },
    // The header cell is rendered by CopyTable from `header`; we need a
    // tri-state checkbox there. CopyTable's header cell is plain text by
    // default — we can't override it without modifying CopyTable. The
    // workaround: render a tiny header-checkbox SIBLING via React portal,
    // OR (simpler) render the header content as a JSX element by
    // overloading the `header` text. CopyTable accepts only string for
    // header. We work around by exposing a separate component below that
    // the parent renders ABOVE the table — but rule #4 says the table
    // owns its caption. To keep one source of truth, the simplest
    // correct approach: piggy-back the header checkbox into the action
    // column's header text via a custom element. Since CopyTable expects
    // string header, we render a wrapper JSX header in a NEW prop name
    // — but adding props to CopyTable is out of scope.
    //
    // Compromise: render the tri-state header checkbox via the
    // `<HeaderCheckbox>` standalone component below; the caller mounts
    // it as a sibling above the table. The action-column header text
    // here stays empty so the column header cell renders blank, which
    // visually pairs with the standalone header checkbox above the table.
    //
    // (We accept the slight visual displacement to avoid CopyTable mods.)
    _selectColumnHeaderState: headerState,
    _selectColumnOnSetAll: () =>
      headerState === "checked" ? onSetAll([]) : onSetAll(visibleIds),
  } as ColumnDef<Row> & {
    _selectColumnHeaderState: typeof headerState;
    _selectColumnOnSetAll: () => void;
  };
}

/**
 * HeaderCheckbox — renders a tri-state checkbox above the CopyTable for the
 * "select all visible rows" gesture. The checkbox column header itself stays
 * blank because CopyTable does not support JSX in `header`.
 */
export interface HeaderCheckboxProps {
  state: "checked" | "unchecked" | "indeterminate";
  onToggle: () => void;
  visibleCount: number;
}
export function HeaderCheckbox({
  state,
  onToggle,
  visibleCount,
}: HeaderCheckboxProps) {
  const ref = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (ref.current) ref.current.indeterminate = state === "indeterminate";
  }, [state]);
  return (
    <label className="inline-flex cursor-pointer items-center gap-1.5 text-[12px] text-muted-foreground">
      <input
        ref={ref}
        type="checkbox"
        checked={state === "checked"}
        onChange={onToggle}
        aria-label={`Select all ${visibleCount} rows`}
        className="size-4 rounded border-border accent-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span>Select all</span>
    </label>
  );
}
