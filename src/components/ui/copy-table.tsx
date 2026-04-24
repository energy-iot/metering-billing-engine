"use client";

// CopyTable — keystone component for entrepreneur URA transcription.
//
// Interaction contract (column-major spreadsheet model):
//   Inside the grid, focus is virtual (one tab stop to enter, one to leave).
//   Key bindings:
//     ArrowUp / Down / Left / Right    move 1 cell
//     Tab / Shift+Tab                  next/prev cell, COLUMN-MAJOR
//                                      (down then to top of next col)
//     Home / End                       first/last cell in current column
//     Cmd+Home / Cmd+End               first cell of first col / last of last
//     PageUp / PageDown                ±10 rows in current column
//     C / Enter / Space                copy focused value, auto-advance down;
//                                      off the last row of a column, jump to
//                                      the TOP of the next column. Off the
//                                      very last cell, fire end-of-table
//                                      announcement and stay put — no silent
//                                      wrap.
//     Esc                              leave the grid (blur the wrapper)
//   Click anywhere on a cell           sets focus + copies (mouse path)
//
// A11y commitments:
//   • <caption> describes the table (row count, column count, copy hint).
//   • <th scope="col"> on column headers; <th scope="row"> on household name.
//   • Each cell carries `aria-label="${columnHeader}, ${rowHeader},
//     ${formattedValue}${copied ? ', copied' : ''}"` — semantic text, not
//     grid coordinates.
//   • aria-live="polite" region announces every copy: "Tier 1 kWh, Aisha M.,
//     47.3, copied to clipboard." Edge cases (start/end of table) also announce.
//   • Focus indicator is dual-channel: 3px ring outline AND saturated --accent
//     background tint, so sun-readability survives losing the tint.
//
// Performance:
//   • Column-major Tab is a single setState in onKeyDown — no per-cell
//     listeners.
//   • TODO(virtualization): for >100 rows wire react-window. Recommended:
//     `react-window` (FixedSizeList — uniform 30px row height) wrapped to
//     keep the keyboard nav span the virtualized window. Sketch:
//       const listRef = useRef<FixedSizeList>(null);
//       useEffect(() => listRef.current?.scrollToItem(focus.r, "smart"),
//                [focus.r]);
//   • Per-cell aria-label string allocation is the hot path at 360 rows ×
//     11 cols. Move format(...) into useMemo per row if profiler flags it.

import * as React from "react";
import { cn } from "@/lib/utils";

/** Row-header or copyable value column (original shape — existing callers unchanged). */
export type ValueColumnDef<Row> = {
  /** Column header text — used for <th> and the per-cell aria-label. */
  header: string;
  /** "row-header" renders as <th scope="row">, no copy. "value" is copyable. */
  kind: "row-header" | "value";
  /** Pull the raw value from a row. */
  accessor: (row: Row) => string | number | null;
  /** Format the value for display. Default: identity → toString. */
  format?: (value: string | number | null, row: Row) => string;
  /** Tailwind classes on the cell (e.g. "text-right"). */
  className?: string;
  /** Optional id used for aria-labelledby compositions. */
  id?: string;
};

/**
 * Action column — renders arbitrary React content per row.
 * Excluded from keyboard nav (no copy-pulse, no focus ring, no aria-label composition).
 * The rendered content is responsible for its own interactivity and accessibility.
 */
export type ActionColumnDef<Row> = {
  kind: "action";
  /** Column header text rendered in <th>. */
  header: string;
  /** Optional aria-label override for the header cell (unused in nav). */
  ariaLabel?: string;
  /** Render arbitrary React content for each row. */
  render: (row: Row) => React.ReactNode;
  /** Tailwind classes on the cell. */
  className?: string;
  /** Optional id used for aria-labelledby compositions. */
  id?: string;
};

/** Discriminated union over all column kinds. */
export type ColumnDef<Row> = ValueColumnDef<Row> | ActionColumnDef<Row>;

export interface CopyTableProps<Row> {
  rows: Row[];
  columns: ColumnDef<Row>[];
  /** Caption text for the table; should describe period + row count. */
  caption: string;
  /** aria-label for the table (short version of caption). */
  ariaLabel?: string;
  className?: string;
  /** Override clipboard write — useful for tests. */
  onCopy?: (value: string, row: Row, col: ColumnDef<Row>) => void;
}

const defaultFormat = (v: string | number | null) =>
  v == null ? "—" : typeof v === "number" ? String(v) : v;

export function CopyTable<Row>({
  rows,
  columns,
  caption,
  ariaLabel,
  className,
  onCopy,
}: CopyTableProps<Row>) {
  // Index of the row-header column (only one supported); numeric value
  // columns are everything else. Focus is restricted to value columns.
  // Action columns are explicitly excluded — they're outside the copy-cell grid.
  const valueColIdxs = React.useMemo(
    () => columns.map((c, i) => (c.kind === "value" ? i : -1)).filter((i) => i >= 0),
    [columns],
  );
  const rowHeaderIdx = React.useMemo(
    () => columns.findIndex((c) => c.kind === "row-header"),
    [columns],
  );

  const firstCol = valueColIdxs[0] ?? 0;
  const lastCol = valueColIdxs[valueColIdxs.length - 1] ?? 0;
  const lastRow = rows.length - 1;

  const [focus, setFocus] = React.useState({ r: 0, c: firstCol });
  const [copied, setCopied] = React.useState<{ r: number; c: number; t: number } | null>(null);
  const [announce, setAnnounce] = React.useState("");
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const pulseRef = React.useRef(0);

  const isValueCol = (c: number) => columns[c]?.kind === "value";
  const nextValueCol = React.useCallback((c: number, dir: 1 | -1): number | null => {
    let i = valueColIdxs.indexOf(c);
    if (i < 0) return null;
    i += dir;
    if (i < 0 || i >= valueColIdxs.length) return null;
    return valueColIdxs[i];
  }, [valueColIdxs]);

  const move = (dr: number, dc: number) => {
    setFocus((f) => {
      let r = f.r + dr;
      let c = f.c;
      if (dc !== 0) {
        // step to nearest value column in the requested direction
        const nxt = nextValueCol(f.c, dc > 0 ? 1 : -1);
        if (nxt != null) c = nxt;
      }
      r = Math.max(0, Math.min(lastRow, r));
      return { r, c };
    });
  };

  const tabCol = (back: boolean) => {
    setFocus((f) => {
      let r = f.r;
      let c = f.c;
      if (!back) {
        r += 1;
        if (r > lastRow) {
          const nxt = nextValueCol(c, 1);
          if (nxt != null) {
            r = 0;
            c = nxt;
          } else {
            r = lastRow;
            setAnnounce("End of table");
          }
        }
      } else {
        r -= 1;
        if (r < 0) {
          const prv = nextValueCol(c, -1);
          if (prv != null) {
            r = lastRow;
            c = prv;
          } else {
            r = 0;
            setAnnounce("Start of table");
          }
        }
      }
      return { r, c };
    });
  };

  const formatCell = React.useCallback(
    (r: number, c: number) => {
      const col = columns[c];
      const row = rows[r];
      if (!col || !row || col.kind === "action") return "";
      const raw = col.accessor(row);
      return (col.format ?? defaultFormat)(raw, row);
    },
    [columns, rows],
  );

  const rowHeaderText = React.useCallback(
    (r: number): string => {
      if (rowHeaderIdx < 0) return `Row ${r + 1}`;
      const col = columns[rowHeaderIdx];
      if (col.kind === "action") return `Row ${r + 1}`;
      const raw = col.accessor(rows[r]);
      return raw == null ? `Row ${r + 1}` : String(raw);
    },
    [columns, rows, rowHeaderIdx],
  );

  const copyAt = React.useCallback(
    (r: number, c: number) => {
      const col = columns[c];
      const row = rows[r];
      if (!col || !row || col.kind !== "value") return;
      const formatted = formatCell(r, c);
      const raw = col.accessor(row);
      const writeText = String(raw ?? "");
      if (onCopy) onCopy(writeText, row, col);
      else navigator.clipboard?.writeText(writeText).catch(() => {});

      pulseRef.current += 1;
      const t = pulseRef.current;
      setCopied({ r, c, t });
      setAnnounce(
        `${col.header}, ${rowHeaderText(r)}, ${formatted}, copied to clipboard`,
      );
      // Auto-advance down; off last row, jump to top of next col; off last
      // cell of last col, stay put with end-of-table announcement.
      setFocus((f) => {
        let nr = f.r + 1;
        let nc = f.c;
        if (nr > lastRow) {
          const nxt = nextValueCol(f.c, 1);
          if (nxt != null) {
            nr = 0;
            nc = nxt;
          } else {
            nr = lastRow;
            setAnnounce((prev) => `${prev}. End of table.`);
          }
        }
        return { r: nr, c: nc };
      });
      setTimeout(() => {
        setCopied((cp) => (cp && cp.t === t ? null : cp));
      }, 900);
    },
    [columns, rows, formatCell, rowHeaderText, lastRow, onCopy, nextValueCol],
  );

  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const meta = e.metaKey || e.ctrlKey;
    switch (e.key) {
      case "ArrowUp":
        e.preventDefault();
        move(-1, 0);
        break;
      case "ArrowDown":
        e.preventDefault();
        move(1, 0);
        break;
      case "ArrowLeft":
        e.preventDefault();
        move(0, -1);
        break;
      case "ArrowRight":
        e.preventDefault();
        move(0, 1);
        break;
      case "Home":
        e.preventDefault();
        if (meta) setFocus({ r: 0, c: firstCol });
        else setFocus((f) => ({ r: 0, c: f.c }));
        break;
      case "End":
        e.preventDefault();
        if (meta) setFocus({ r: lastRow, c: lastCol });
        else setFocus((f) => ({ r: lastRow, c: f.c }));
        break;
      case "PageUp":
        e.preventDefault();
        move(-10, 0);
        break;
      case "PageDown":
        e.preventDefault();
        move(10, 0);
        break;
      case "Tab":
        e.preventDefault();
        tabCol(e.shiftKey);
        break;
      case "Escape":
        e.preventDefault();
        wrapRef.current?.blur();
        setAnnounce("Left grid");
        break;
      case "Enter":
      case "c":
      case "C":
      case " ":
      case "Space":
        e.preventDefault();
        if (isValueCol(focus.c)) copyAt(focus.r, focus.c);
        break;
      default:
        return;
    }
  };

  return (
    <div className={cn("relative", className)}>
      {/* aria-live announcer (sr-only). */}
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announce}
      </div>
      <div
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={onKey}
        aria-label={ariaLabel ?? caption}
        className={cn(
          "relative overflow-auto rounded-md border border-border outline-none",
          "focus-visible:shadow-[0_0_0_3px_color-mix(in_oklch,var(--ring)_25%,transparent)]",
        )}
      >
        <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
          <caption className="sr-only">
            {caption}. Use arrow keys to move; press C or Enter to copy a cell.
          </caption>
          <thead>
            <tr>
              {columns.map((col, ci) => (
                <th
                  key={ci}
                  scope="col"
                  id={col.id ?? `mbe-col-${ci}`}
                  className={cn(
                    "h-8 whitespace-nowrap border-b border-border px-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground",
                    col.kind === "row-header" ? "text-left" : col.kind === "action" ? "text-center" : "text-right",
                    col.className,
                  )}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r} className="border-b border-border last:border-b-0">
                {columns.map((col, c) => {
                  // Action columns: plain <td> with rendered content — no copy, no focus, no aria-label composition.
                  if (col.kind === "action") {
                    return (
                      <td
                        key={c}
                        className={cn(
                          "h-[30px] whitespace-nowrap px-2 text-center",
                          col.className,
                        )}
                      >
                        {col.render(row)}
                      </td>
                    );
                  }

                  const formatted = formatCell(r, c);
                  if (col.kind === "row-header") {
                    return (
                      <th
                        key={c}
                        scope="row"
                        className={cn(
                          "h-[30px] whitespace-nowrap px-3 text-left font-sans text-[12px] font-medium text-foreground",
                          col.className,
                        )}
                      >
                        {formatted}
                      </th>
                    );
                  }
                  const isFocus = focus.r === r && focus.c === c;
                  const isCopied = copied?.r === r && copied?.c === c;
                  return (
                    <td
                      key={c}
                      onClick={() => {
                        setFocus({ r, c });
                        copyAt(r, c);
                      }}
                      aria-label={`${col.header}, ${rowHeaderText(r)}, ${formatted}${isCopied ? ", copied" : ""}`}
                      className={cn(
                        "relative h-[30px] cursor-pointer whitespace-nowrap rounded-sm px-2 text-right transition-colors duration-fast",
                        isFocus &&
                          "bg-accent outline outline-[3px] -outline-offset-[3px] outline-ring",
                        isCopied && "bg-success-muted",
                        col.className,
                      )}
                    >
                      {formatted}
                      {isCopied && (
                        <span aria-hidden="true" className="ml-1 text-[11px] font-semibold text-success-fg">
                          ✓
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
