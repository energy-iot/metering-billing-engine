"use client";

// PeriodPicker — billing period selector / switcher.
//
// Contract:
//   • Trigger button shows the current period date range + status chip.
//   • Open panel lists all periods, scoped to maxHeight (overflow-y auto)
//     so 24+ periods don't blow out the layout.
//   • Keyboard: Enter/Space opens; ↑/↓ navigates options; Enter selects;
//     Esc closes. role="listbox" + aria-selected pattern (listbox-with-selected,
//     NOT activedescendant).
//   • "+ New period" is rendered as a primary button — period creation
//     is one of three core admin actions, not a ghost.
//   • Same-day periods render as a single date (e.g. "2026-02-15") not
//     "Feb 15 → Feb 15".
//   • States: empty (no periods) / loading (skeleton rows) / error
//     (retry inline). Disabled trigger when the user can't select.

import * as React from "react";
import * as Popover from "@radix-ui/react-popover";
import { cn } from "@/lib/utils";
import { Currency } from "@/components/format/currency";
import { StatusChip } from "./status-chip";

export type PeriodStatus = "draft" | "closed";

export type PeriodOption = {
  id: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  status: PeriodStatus;
  totalAmount: number;
};

export interface PeriodPickerProps {
  periods: PeriodOption[];
  currentId?: string;
  onSelect: (period: PeriodOption) => void;
  onNewPeriod?: () => void;
  loading?: boolean;
  error?: string | null;
  disabled?: boolean;
  className?: string;
}

export function PeriodPicker({
  periods,
  currentId,
  onSelect,
  onNewPeriod,
  loading,
  error,
  disabled,
  className,
}: PeriodPickerProps) {
  const current = periods.find((p) => p.id === currentId) ?? periods[0];
  const [open, setOpen] = React.useState(false);
  const [activeIdx, setActiveIdx] = React.useState(() =>
    Math.max(0, periods.findIndex((p) => p.id === currentId)),
  );

  const onPanelKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(periods.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const p = periods[activeIdx];
      if (p) {
        onSelect(p);
        setOpen(false);
      }
    }
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          disabled={disabled}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md border border-border bg-card px-3 text-[13px] font-medium text-foreground",
            "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "disabled:cursor-not-allowed disabled:opacity-50",
            className,
          )}
          aria-haspopup="listbox"
          aria-expanded={open}
        >
          {current ? (
            <>
              <span className="font-mono">{formatRange(current.startDate, current.endDate)}</span>
              <StatusChip kind="billingPeriod" status={current.status} size="sm" />
            </>
          ) : (
            <span className="text-muted-foreground">No period selected</span>
          )}
          <ChevronDown />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-80 rounded-md border border-border bg-card shadow-elev-3 outline-none"
        >
          <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
            <div className="text-[12px] font-semibold">Select billing period</div>
            {onNewPeriod && (
              <button
                onClick={() => {
                  setOpen(false);
                  onNewPeriod();
                }}
                className="inline-flex h-6 items-center rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                + New period
              </button>
            )}
          </div>
          <div
            role="listbox"
            aria-label="Billing periods"
            tabIndex={-1}
            onKeyDown={onPanelKey}
            className="max-h-80 overflow-y-auto"
          >
            {loading ? (
              <div className="space-y-1.5 p-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-4/5" />
                <Skeleton className="h-5 w-11/12" />
              </div>
            ) : error ? (
              <div className="m-3 rounded-md bg-destructive-muted px-3 py-2.5 text-[13px] text-destructive-fg">
                Couldn&apos;t load periods. <button className="underline">Retry</button>
              </div>
            ) : periods.length === 0 ? (
              <div className="m-3 rounded-md border border-dashed border-border bg-muted px-3 py-4 text-center text-[12px] text-muted-foreground">
                <div className="mb-1.5 font-semibold text-foreground">No periods yet</div>
                {onNewPeriod && (
                  <button
                    onClick={onNewPeriod}
                    className="inline-flex h-6 items-center rounded-md bg-primary px-2.5 text-[12px] font-medium text-primary-foreground"
                  >
                    + Create the first
                  </button>
                )}
              </div>
            ) : (
              periods.map((p, i) => (
                <button
                  key={p.id}
                  role="option"
                  aria-selected={i === activeIdx}
                  onClick={() => {
                    onSelect(p);
                    setOpen(false);
                  }}
                  onMouseEnter={() => setActiveIdx(i)}
                  className={cn(
                    "flex w-full items-center gap-2.5 border-b border-border px-3 py-2.5 text-left last:border-b-0",
                    i === activeIdx && "bg-muted",
                  )}
                >
                  <StatusChip kind="billingPeriod" status={p.status} size="sm" />
                  <span className="font-mono text-[12px] text-foreground">
                    {formatRange(p.startDate, p.endDate)}
                  </span>
                  <Currency
                    value={p.totalAmount}
                    className="ml-auto text-[12px] text-muted-foreground"
                  />
                </button>
              ))
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function formatRange(start: string, end: string): string {
  return start === end ? start : `${start} → ${end}`;
}

function Skeleton({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-sm bg-muted",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="absolute inset-0 [animation:mbe-shimmer_1.4s_ease-in-out_infinite]"
        style={{
          backgroundImage:
            "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)",
        }}
      />
    </div>
  );
}

function ChevronDown() {
  return (
    <svg
      aria-hidden="true"
      width="10"
      height="10"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6 L8 10 L12 6" />
    </svg>
  );
}
