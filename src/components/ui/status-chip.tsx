// StatusChip — thin semantic wrapper over <Chip>.
//
// Why: keeps domain status enums (billing period status, edge status,
// household status, meter type) in ONE PLACE so callers don't need to
// remember which tone maps to "draft" vs "closed". When the schema's
// status set evolves, only this file changes.
//
// Pattern: <StatusChip kind="billingPeriod" status="draft" /> —
// renders the right tone + label + dot + aria-label.

import * as React from "react";
import { Chip, type ChipProps } from "./chip";

type Kind =
  | "billingPeriod"
  | "edge"
  | "household"
  | "meterType";

type StatusMap = Record<string, { label: string; tone: ChipProps["tone"]; dot?: boolean }>;

const MAPS: Record<Kind, StatusMap> = {
  billingPeriod: {
    draft:  { label: "Draft",  tone: "warn",    dot: true },
    closed: { label: "Closed", tone: "success", dot: true },
  },
  edge: {
    online:   { label: "Online",   tone: "success", dot: true },
    degraded: { label: "Degraded", tone: "warn",    dot: true },
    offline:  { label: "Offline",  tone: "alert",   dot: true },
    stale:    { label: "Stale",    tone: "success", dot: true }, // pair with state="stale"
  },
  household: {
    active:   { label: "Active",   tone: "success", dot: true },
    inactive: { label: "Inactive", tone: "neutral", dot: true },
    disputed: { label: "Disputed", tone: "alert",   dot: true },
  },
  meterType: {
    // Lowercase keys (original)
    grid:        { label: "Grid",        tone: "brand" },
    consumption: { label: "Consumption", tone: "warn" },
    production:  { label: "Production",  tone: "success" },
    unknown:     { label: "Unknown",     tone: "neutral" },
    // Uppercase keys — openems types.ts:75 emits uppercase meter_type
    GRID:        { label: "Grid",        tone: "brand" },
    CONSUMPTION: { label: "Consumption", tone: "warn" },
    PRODUCTION:  { label: "Production",  tone: "success" },
    UNKNOWN:     { label: "Unknown",     tone: "neutral" },
  },
};

export interface StatusChipProps extends Omit<ChipProps, "tone" | "children" | "dot"> {
  kind: Kind;
  status: string;
}

export function StatusChip({ kind, status, ...props }: StatusChipProps) {
  const map = MAPS[kind];
  const entry = map[status];
  if (!entry) {
    // Unknown status — fail loudly in dev, fall back to neutral chip.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`StatusChip: unknown status "${status}" for kind "${kind}".`);
    }
    return (
      <Chip tone="neutral" aria-label={`${kind}: ${status}`} {...props}>
        {status}
      </Chip>
    );
  }
  return (
    <Chip
      tone={entry.tone}
      dot={entry.dot}
      aria-label={`${kind} status: ${entry.label.toLowerCase()}`}
      {...props}
    >
      {entry.label}
    </Chip>
  );
}
