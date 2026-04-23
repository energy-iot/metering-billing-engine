"use client";

/**
 * BlastRadiusList — renders `DescendantCounts` as a human-readable list
 * inside the entity-delete ConfirmDialog (#89 / AC-UI-4).
 *
 * Rendering rules:
 *   * For each non-zero count, render an `<li>` with plain-language copy.
 *   * Zero counts are omitted.
 *   * When every count is zero, render a single line "This entity has no
 *     descendants." rather than an empty list or a row of zeros.
 *   * Billing periods render as two separate lines (draft vs closed) —
 *     never combined — per AC-ROUTE-8 / AC-UI-4. Draft copy includes
 *     the "unfinalized readings will be lost" phrasing so the operator
 *     sees that they're destroying in-progress work.
 *   * For `edge.billing_line_items_nulled` the copy explicitly calls out
 *     that rows SURVIVE (linkage severed, not destroyed). Same for
 *     `edge.household_devices` — households themselves are preserved
 *     but their meter linkage breaks.
 *   * Numerals format via `Intl.NumberFormat` with `Accept-Language` or
 *     the default browser locale (pilot numbers <1000 render identically
 *     across locales — AC-UI-5 note). Do NOT hand-roll a formatter.
 *
 * The `asOf` timestamp renders as a small muted caption underneath so
 * the operator sees the staleness window acknowledged in AC-ROUTE-6.
 */

import * as React from "react";
import type { DescendantCounts } from "@/lib/entity-descendants";
import { descendantCountsAreEmpty } from "@/lib/entity-descendants";

// In-module NumberFormat cache; keyed by the resolved browser locale.
// Matches the pattern used by src/components/format/currency.tsx for
// its own cache. Safe for client components — lives across renders.
const nfCache = new Map<string, Intl.NumberFormat>();
function nf(): Intl.NumberFormat {
  const locale =
    typeof navigator !== "undefined" ? navigator.language : "en-US";
  let cached = nfCache.get(locale);
  if (!cached) {
    cached = new Intl.NumberFormat(locale);
    nfCache.set(locale, cached);
  }
  return cached;
}

function fmt(n: number): string {
  return nf().format(n);
}

function pluralize(n: number, singular: string, plural?: string): string {
  return n === 1 ? singular : plural ?? `${singular}s`;
}

/** Build the list of `<li>` nodes for the given counts. */
function buildItems(counts: DescendantCounts): React.ReactNode[] {
  const items: React.ReactNode[] = [];

  switch (counts.kind) {
    case "organization":
      if (counts.communities > 0)
        items.push(
          <li key="communities">
            {fmt(counts.communities)}{" "}
            {pluralize(counts.communities, "community", "communities")}
          </li>
        );
      if (counts.microgrids > 0)
        items.push(
          <li key="microgrids">
            {fmt(counts.microgrids)} {pluralize(counts.microgrids, "microgrid")}
          </li>
        );
      if (counts.edges > 0)
        items.push(
          <li key="edges">
            {fmt(counts.edges)} {pluralize(counts.edges, "edge")}
          </li>
        );
      if (counts.devices > 0)
        items.push(
          <li key="devices">
            {fmt(counts.devices)} {pluralize(counts.devices, "device")}
          </li>
        );
      if (counts.households > 0)
        items.push(
          <li key="households">
            {fmt(counts.households)} {pluralize(counts.households, "household")}
          </li>
        );
      if (counts.household_devices > 0)
        items.push(
          <li key="hd">
            {fmt(counts.household_devices)} household↔meter{" "}
            {pluralize(counts.household_devices, "link")}
          </li>
        );
      if (counts.household_users > 0)
        items.push(
          <li key="hu">
            {fmt(counts.household_users)} household user{" "}
            {pluralize(counts.household_users, "link")}
          </li>
        );
      if (counts.billing_periods_draft > 0)
        items.push(
          <li key="bpd">
            {fmt(counts.billing_periods_draft)} draft billing{" "}
            {pluralize(counts.billing_periods_draft, "period")} (in progress —
            unfinalized readings will be lost)
          </li>
        );
      if (counts.billing_periods_closed > 0)
        items.push(
          <li key="bpc">
            {fmt(counts.billing_periods_closed)} closed billing{" "}
            {pluralize(counts.billing_periods_closed, "period")}
          </li>
        );
      if (counts.billing_line_items > 0)
        items.push(
          <li key="bli">
            {fmt(counts.billing_line_items)} billing line{" "}
            {pluralize(counts.billing_line_items, "item")}
          </li>
        );
      if (counts.rate_schedules > 0)
        items.push(
          <li key="rs">
            {fmt(counts.rate_schedules)} rate{" "}
            {pluralize(counts.rate_schedules, "schedule")}
          </li>
        );
      if (counts.user_roles > 0)
        items.push(
          <li key="ur">
            {fmt(counts.user_roles)} org_manager role{" "}
            {pluralize(counts.user_roles, "assignment")}
          </li>
        );
      break;

    case "community":
      if (counts.microgrids > 0)
        items.push(
          <li key="microgrids">
            {fmt(counts.microgrids)} {pluralize(counts.microgrids, "microgrid")}
          </li>
        );
      if (counts.edges > 0)
        items.push(
          <li key="edges">
            {fmt(counts.edges)} {pluralize(counts.edges, "edge")}
          </li>
        );
      if (counts.devices > 0)
        items.push(
          <li key="devices">
            {fmt(counts.devices)} {pluralize(counts.devices, "device")}
          </li>
        );
      if (counts.households > 0)
        items.push(
          <li key="households">
            {fmt(counts.households)} {pluralize(counts.households, "household")}
          </li>
        );
      if (counts.household_devices > 0)
        items.push(
          <li key="hd">
            {fmt(counts.household_devices)} household↔meter{" "}
            {pluralize(counts.household_devices, "link")}
          </li>
        );
      if (counts.household_users > 0)
        items.push(
          <li key="hu">
            {fmt(counts.household_users)} household user{" "}
            {pluralize(counts.household_users, "link")}
          </li>
        );
      if (counts.billing_periods_draft > 0)
        items.push(
          <li key="bpd">
            {fmt(counts.billing_periods_draft)} draft billing{" "}
            {pluralize(counts.billing_periods_draft, "period")} (in progress —
            unfinalized readings will be lost)
          </li>
        );
      if (counts.billing_periods_closed > 0)
        items.push(
          <li key="bpc">
            {fmt(counts.billing_periods_closed)} closed billing{" "}
            {pluralize(counts.billing_periods_closed, "period")}
          </li>
        );
      if (counts.billing_line_items > 0)
        items.push(
          <li key="bli">
            {fmt(counts.billing_line_items)} billing line{" "}
            {pluralize(counts.billing_line_items, "item")}
          </li>
        );
      if (counts.rate_schedules > 0)
        items.push(
          <li key="rs">
            {fmt(counts.rate_schedules)} rate{" "}
            {pluralize(counts.rate_schedules, "schedule")}
          </li>
        );
      break;

    case "microgrid":
      if (counts.edges > 0)
        items.push(
          <li key="edges">
            {fmt(counts.edges)} {pluralize(counts.edges, "edge")}
          </li>
        );
      if (counts.devices > 0)
        items.push(
          <li key="devices">
            {fmt(counts.devices)} {pluralize(counts.devices, "device")}
          </li>
        );
      if (counts.households > 0)
        items.push(
          <li key="households">
            {fmt(counts.households)} {pluralize(counts.households, "household")}
          </li>
        );
      if (counts.household_devices > 0)
        items.push(
          <li key="hd">
            {fmt(counts.household_devices)} household↔meter{" "}
            {pluralize(counts.household_devices, "link")}
          </li>
        );
      if (counts.household_users > 0)
        items.push(
          <li key="hu">
            {fmt(counts.household_users)} household user{" "}
            {pluralize(counts.household_users, "link")}
          </li>
        );
      if (counts.billing_periods_draft > 0)
        items.push(
          <li key="bpd">
            {fmt(counts.billing_periods_draft)} draft billing{" "}
            {pluralize(counts.billing_periods_draft, "period")} (in progress —
            unfinalized readings will be lost)
          </li>
        );
      if (counts.billing_periods_closed > 0)
        items.push(
          <li key="bpc">
            {fmt(counts.billing_periods_closed)} closed billing{" "}
            {pluralize(counts.billing_periods_closed, "period")}
          </li>
        );
      if (counts.billing_line_items > 0)
        items.push(
          <li key="bli">
            {fmt(counts.billing_line_items)} billing line{" "}
            {pluralize(counts.billing_line_items, "item")}
          </li>
        );
      if (counts.rate_schedules > 0)
        items.push(
          <li key="rs">
            {fmt(counts.rate_schedules)} rate{" "}
            {pluralize(counts.rate_schedules, "schedule")}
          </li>
        );
      break;

    case "edge":
      if (counts.devices > 0)
        items.push(
          <li key="devices">
            {fmt(counts.devices)} {pluralize(counts.devices, "device")}
          </li>
        );
      if (counts.household_devices > 0)
        items.push(
          <li key="hd">
            {fmt(counts.household_devices)} household↔meter{" "}
            {pluralize(counts.household_devices, "link")} will be severed
            (households preserved but will need meter re-linking before next
            close)
          </li>
        );
      if (counts.billing_line_items_nulled > 0)
        items.push(
          <li key="blin">
            {fmt(counts.billing_line_items_nulled)} billing line{" "}
            {pluralize(counts.billing_line_items_nulled, "item")} will lose
            their device linkage (historical records preserved)
          </li>
        );
      break;
  }

  return items;
}

export interface BlastRadiusListProps {
  counts: DescendantCounts;
  /** ISO 8601 timestamp of the preview query — rendered as a muted caption. */
  asOf: string;
}

export function BlastRadiusList({ counts, asOf }: BlastRadiusListProps) {
  const items = buildItems(counts);
  const empty = descendantCountsAreEmpty(counts);

  // Format the "counts as of" time. Locale-aware with graceful fallback.
  let asOfLabel = "";
  try {
    const d = new Date(asOf);
    asOfLabel = d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    asOfLabel = asOf;
  }

  return (
    <div>
      {empty ? (
        <ul className="my-2 list-disc pl-5">
          <li>This entity has no descendants.</li>
        </ul>
      ) : (
        <ul className="my-2 list-disc space-y-0.5 pl-5">{items}</ul>
      )}
      <p className="mt-2 text-[11px] text-muted-foreground">
        Counts as of {asOfLabel}
      </p>
    </div>
  );
}
