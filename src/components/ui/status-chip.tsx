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
  | "edgeSource"
  | "deviceType"
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
  // Edge data-source classification — mirrors `edge_data_source` enum in AB #50.
  // Tones: brand for the default (openems); neutral for the non-OpenEMS hedge
  // sources (modbus_direct, mqtt, rest_api). No dot — this is a type label,
  // not a connectivity state.
  edgeSource: {
    openems:       { label: "OpenEMS",       tone: "brand" },
    modbus_direct: { label: "Modbus direct", tone: "neutral" },
    mqtt:          { label: "MQTT",          tone: "neutral" },
    rest_api:      { label: "REST API",      tone: "neutral" },
  },
  household: {
    active:   { label: "Active",   tone: "success", dot: true },
    inactive: { label: "Inactive", tone: "neutral", dot: true },
    disputed: { label: "Disputed", tone: "alert",   dot: true },
  },
  // Canonical device-type chip — mirrors `device_type` enum in AB #50.
  // Tone rationale (per mock mgm-ia-v1.html § IA note line 1794):
  //   consumption_meter → warn (billable — draws Aaron's attention)
  //   grid_meter        → brand (the microgrid-level import/export feed)
  //   pv_meter          → success (generation)
  //   battery           → success (storage, charging tone)
  //   inverter          → brand (power conversion equipment)
  //   ev_charger        → brand (controllable load)
  //   other             → neutral (catchall)
  deviceType: {
    consumption_meter: { label: "Consumption meter", tone: "warn" },
    grid_meter:        { label: "Grid meter",        tone: "brand" },
    pv_meter:          { label: "PV meter",          tone: "success" },
    battery:           { label: "Battery",           tone: "success" },
    inverter:          { label: "Inverter",          tone: "brand" },
    ev_charger:        { label: "EV charger",        tone: "brand" },
    other:             { label: "Other",             tone: "neutral" },
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
