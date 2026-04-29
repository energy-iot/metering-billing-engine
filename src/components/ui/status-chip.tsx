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
import * as Tooltip from "@radix-ui/react-tooltip";
import { Chip, type ChipProps } from "./chip";
import { cn } from "@/lib/utils";

type Kind =
  | "billingPeriod"
  | "billingLineItemPaymentStatus"
  | "billingLineItemReadingSource"
  | "edge"
  | "edgeSource"
  | "deviceType"
  | "household"
  | "householdCustomerType"
  | "householdDeviceRole"
  | "meter"
  | "meterType"
  | "openemsBackendHealth"
  | "paymentHealth";

type StatusMap = Record<string, { label: string; tone: ChipProps["tone"]; dot?: boolean }>;

const MAPS: Record<Kind, StatusMap> = {
  // Billing line item payment status — maps the billing_line_item_payment_status
  // enum (migrations 00021 + 00027/00028) to chip tones for the manual mark-paid +
  // IPN Phase B UI (#124, #157).
  //
  // Tone rationale (per Designer §3 evaluation lens, existing token set):
  //   unpaid          → neutral  (resting state — no action taken yet)
  //   link_generated  → warn     (link out, awaiting payment — pending state)
  //   paid            → success  (money received — positive outcome)
  //   failed          → alert    (payment failed — attention required; dot marker)
  //   refunded        → neutral  (terminal, informational)
  billingLineItemPaymentStatus: {
    unpaid:         { label: "Unpaid",         tone: "neutral"                   },
    link_generated: { label: "Link sent",      tone: "warn",    dot: true        },
    paid:           { label: "Paid",           tone: "success", dot: true        },
    failed:         { label: "Failed",         tone: "alert",   dot: true        },
    refunded:       { label: "Refunded",       tone: "neutral"                   },
  },
  // BC2 (#174) — billing_line_items.reading_source provenance chip.
  // Display-only: indicates whether a row's kWh values came from the edge
  // device feed (auto-generated) or from operator manual entry. Tones:
  //   edge   → success (the auto path "just works" — positive default)
  //   manual → neutral (no `info` tone in BannerTone/Chip — neutral is the
  //                     resting indicator for human-entered data; the
  //                     entered-by caption beneath communicates "who").
  billingLineItemReadingSource: {
    edge:   { label: "Edge",   tone: "success" },
    manual: { label: "Manual", tone: "neutral" },
  },
  billingPeriod: {
    draft:  { label: "Draft",  tone: "warn",    dot: true },
    closed: { label: "Closed", tone: "success", dot: true },
  },
  edge: {
    online:   { label: "Online",   tone: "success", dot: true },
    degraded: { label: "Degraded", tone: "warn",    dot: true },
    offline:  { label: "Offline",  tone: "alert",   dot: true },
    stale:    { label: "Stale",    tone: "success", dot: true }, // pair with state="stale"
    unknown:  { label: "Unknown",  tone: "neutral", dot: true },
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
  // PDF3 (#205) — household customer-type chip surfaced inside the
  // HouseholdTable's Household cell. Mirrors the `customer_type` column
  // (residential | commercial; PDF1a / 00033). No `info` tone in the
  // existing tone set — `neutral` (resting; the majority class) and
  // `brand` (visually distinct; commercial) carry the contrast.
  householdCustomerType: {
    residential: { label: "Residential", tone: "neutral" },
    commercial:  { label: "Commercial",  tone: "brand"   },
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
  // Household device role — mirrors `household_device_role` enum in AB schema.
  // Tone rationale:
  //   primary_consumption_meter → warn (the billable metering device; draws attention)
  //   secondary_meter           → neutral (supplementary measurement, non-primary)
  //   battery                   → success (storage asset)
  //   solar                     → success (generation asset)
  //   ev_charger                → brand (controllable load)
  //   other                     → neutral (catchall)
  householdDeviceRole: {
    primary_consumption_meter: { label: "Primary meter", tone: "warn" },
    secondary_meter:           { label: "Secondary meter", tone: "neutral" },
    battery:                   { label: "Battery",         tone: "success" },
    solar:                     { label: "Solar",           tone: "success" },
    ev_charger:                { label: "EV charger",      tone: "brand" },
    other:                     { label: "Other",           tone: "neutral" },
  },
  // #158: per-household meter assignment status. The HouseholdTable cell
  // surfaces this so an entrepreneur can tell at a glance which households
  // require a manual usage entry each period vs. the metered/automated flow.
  //
  // Tone rationale:
  //   linked          → success (the OpenEMS reading flow is wired)
  //   not_configured  → warn (manual billing is an active state, not an
  //                     error — but it does need attention each period)
  meter: {
    linked:         { label: "Meter linked",   tone: "success", dot: true },
    not_configured: { label: "No meter",       tone: "warn",    dot: true },
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
  // OpenEMS Backend per-microgrid health (#102).
  //   healthy       — recent (< 24h) successful Discover.
  //   stale         — last Discover ≥ 24h ago; user should run "Test again".
  //   failing       — last Discover ended in auth_failed / unreachable /
  //                   zero_edges / unknown_error.
  //   not_configured — ems_type IS NULL; no Discover has run. NO dot (chip
  //                   shouldn't imply any state, just absence).
  openemsBackendHealth: {
    healthy:        { label: "Healthy",       tone: "success", dot: true  },
    stale:          { label: "Stale",         tone: "warn",    dot: true  },
    failing:        { label: "Failing",       tone: "alert",   dot: true  },
    not_configured: { label: "Not connected", tone: "neutral" /* no dot */ },
  },
  // Community Payment-provider health (#119).
  //   healthy        — payment_last_configured_at is recent (< 24h).
  //   stale          — configured but last Save & test was ≥ 24h ago; user
  //                    should "Test again".
  //   failing        — RESERVED for #121 (IPN webhook failure tracking).
  //                    `derivePaymentHealth` never emits this today, but the
  //                    MAPS entry stays pinned so Designer §3's tone table
  //                    remains stable across the deferred-IPN rollout.
  //   not_configured — payment_provider IS NULL (no dot — just absence).
  paymentHealth: {
    healthy:        { label: "Healthy",       tone: "success", dot: true  },
    stale:          { label: "Stale",         tone: "warn",    dot: true  },
    failing:        { label: "Failing",       tone: "alert",   dot: true  },
    not_configured: { label: "Not connected", tone: "neutral" /* no dot */ },
  },
};

export interface StatusChipProps extends Omit<ChipProps, "tone" | "children" | "dot"> {
  kind: Kind;
  status: string;
  /**
   * Optional tooltip content. When supplied, the chip is wrapped in a
   * Radix Tooltip (hover + keyboard focus). Added in #102 for the OpenEMS
   * Backend health chip (tab-label chip) where the long explanation
   * wouldn't fit inline. The summary-card health chip reads the info from
   * its surrounding text so callers don't need to duplicate the copy.
   */
  tooltip?: React.ReactNode;
}

export function StatusChip({ kind, status, tooltip, ...props }: StatusChipProps) {
  const map = MAPS[kind];
  const entry = map[status];

  const chip = !entry ? (
    // Unknown status — fail loudly in dev, fall back to neutral chip.
    (() => {
      if (process.env.NODE_ENV !== "production") {
        console.warn(`StatusChip: unknown status "${status}" for kind "${kind}".`);
      }
      return (
        <Chip tone="neutral" aria-label={`${kind}: ${status}`} {...props}>
          {status}
        </Chip>
      );
    })()
  ) : (
    <Chip
      tone={entry.tone}
      dot={entry.dot}
      aria-label={`${kind} status: ${entry.label.toLowerCase()}`}
      {...props}
    >
      {entry.label}
    </Chip>
  );

  if (!tooltip) return chip;

  // Wrap in Radix Tooltip. Caller is responsible for providing a
  // TooltipProvider at or near the app root; we inline one here as a
  // defensive default so single-use sites (the tab chip) don't need to
  // refactor the layout tree. Radix Providers nest safely.
  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          {/* Wrap in a focusable span so keyboard users get the tooltip.
              tabIndex=0 makes the chip focusable without turning it into
              a button (preserves non-interactive semantics). */}
          <span tabIndex={0} className="inline-flex cursor-default rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {chip}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className={cn(
              "z-50 max-w-xs rounded-md bg-foreground px-3 py-2 text-[12px] leading-snug text-background shadow-elev-2",
              "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out"
            )}
          >
            {tooltip}
            <Tooltip.Arrow className="fill-foreground" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
