"use client";

// ConsumptionCalendar — 7-column grid of ConsumptionCells with header.
//
// Contract:
//   • `days` is the data for the period — one entry per visible day,
//     in chronological order. Future days carry status='future';
//     missing past readings carry status='missing'.
//   • Renders a legend with shape variation in addition to color
//     (circle = within, square = near, triangle = over) so deuteranopes
//     get a parallel signal channel.
//   • Threshold + mode props pass through to each cell.
//   • onDaySelect lets the page route to a per-day drill-in.

import * as React from "react";
import { cn } from "@/lib/utils";
import { ConsumptionCell } from "./consumption-cell";

export type ConsumptionDay = {
  day: number;
  pct: number | null;
  kwh: number | null;
  status?: "future" | "missing";
};

export interface ConsumptionCalendarProps {
  days: ConsumptionDay[];
  small?: boolean;
  thresholds?: { success: number; warn: number };
  mode?: "budget" | "relative" | "absolute";
  weekStart?: "M" | "S";
  onDaySelect?: (day: number) => void;
  className?: string;
}

const HEADERS = {
  M: ["M", "T", "W", "T", "F", "S", "S"],
  S: ["S", "M", "T", "W", "T", "F", "S"],
};

export function ConsumptionCalendar({
  days,
  small = false,
  thresholds,
  mode,
  weekStart = "M",
  onDaySelect,
  className,
}: ConsumptionCalendarProps) {
  return (
    <div className={cn("font-sans", className)}>
      <div className="mb-2 grid grid-cols-7 gap-1.5">
        {HEADERS[weekStart].map((d, i) => (
          <div
            key={`${d}-${i}`}
            className="text-center text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
          >
            {d}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((d, i) => (
          <ConsumptionCell
            key={i}
            day={d.day}
            pct={d.pct}
            kwh={d.kwh}
            status={d.status}
            small={small}
            thresholds={thresholds}
            mode={mode}
            onSelect={onDaySelect ? () => onDaySelect(d.day) : undefined}
          />
        ))}
      </div>
      <div className="mt-2 flex gap-3 text-[11px] text-muted-foreground">
        <Legend shape="circle" colorClass="bg-success" label="within" />
        <Legend shape="square" colorClass="bg-warning" label="near" />
        <Legend shape="triangle" colorClass="bg-destructive" label="over" />
      </div>
    </div>
  );
}

function Legend({
  shape,
  colorClass,
  label,
}: {
  shape: "circle" | "square" | "triangle";
  colorClass: string;
  label: string;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden="true" className={shapeClass(shape, colorClass)} />
      {label}
    </span>
  );
}

function shapeClass(shape: "circle" | "square" | "triangle", color: string): string {
  switch (shape) {
    case "circle":
      return `inline-block h-2 w-2 rounded-full ${color}`;
    case "square":
      return `inline-block h-2 w-2 ${color}`;
    case "triangle":
      // CSS triangle via borders — leave color inline to keep token reference.
      return "inline-block h-0 w-0 border-x-[5px] border-x-transparent border-b-[8px] border-b-[color:var(--destructive)]";
  }
}
