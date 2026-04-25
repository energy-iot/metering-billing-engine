"use client";

/**
 * DeviceSelect — Radix-based picker for billing devices, replacing the bare
 * native <select> + <optgroup> previously rendered inline in HouseholdTable.
 *
 * Variant B always: every option shows the edge label as a second line and
 * groups are headed with `Edge · <edge_name>`, even on single-edge
 * microgrids. The previous `showEdgeLabel` toggle is gone — operator
 * decision on 2026-04-25 (#145 ticket): always disambiguate by edge so
 * the rendering doesn't shift when an edge is added later.
 *
 * Already-linked devices: greyed (`opacity-60`) + Radix `disabled` + suffix
 * "linked to <household>". They are NOT selectable from this surface; the
 * source household's edit dialog is the only place to reassign.
 *
 * Empty state: when `devices.length === 0`, the dropdown collapses to an
 * inline mini empty-state with a link to the microgrid's edges page.
 *
 * Sort order:
 *   1. Groups: alphabetical by edge_name
 *   2. Within a group: AVAILABLE devices first (alphabetical by name),
 *      then LINKED-elsewhere devices (alphabetical, dimmed)
 *
 * A11y:
 *   - Radix Select handles roving-tabindex, type-ahead, ESC dismiss
 *   - Group headers are SelectLabel inside SelectGroup
 *   - Disabled items get `aria-disabled` automatically via the Radix prop
 *   - `aria-describedby` on the trigger is forwarded by the caller
 */

import * as React from "react";
import Link from "next/link";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Chip } from "@/components/ui/chip";
import { humanReadable } from "@/lib/openems/device-descriptions";
import { cn } from "@/lib/utils";

export type DeviceOption = {
  id: string;
  name: string;
  device_type: string;
  edge_id: string;
  edge_name: string;
  /**
   * When set, this device is already the primary_consumption_meter of
   * another household. The option renders disabled with a "linked" suffix.
   * The CALLER is responsible for clearing this on the option that matches
   * `value` when this household is the device's owner — otherwise the
   * current selection would render disabled in its own picker.
   */
  linkedToHouseholdName?: string | null;
};

export interface DeviceSelectProps {
  devices: DeviceOption[];
  value: string | null;
  onChange: (deviceId: string | null) => void;
  /** Href to the microgrid's edges page — surfaced inside the empty-state. */
  edgesSetupHref: string;
  /** Forwarded to the SelectTrigger for screen-reader linkage to helper text. */
  "aria-describedby"?: string;
  disabled?: boolean;
  /** Forwarded to the SelectTrigger for label association. */
  "aria-label"?: string;
}

const UNASSIGNED_VALUE = "__unassigned__";

export function DeviceSelect({
  devices,
  value,
  onChange,
  edgesSetupHref,
  "aria-describedby": describedBy,
  "aria-label": ariaLabel,
  disabled,
}: DeviceSelectProps) {
  const grouped = React.useMemo(() => groupByEdge(devices), [devices]);
  const isEmpty = devices.length === 0;
  const selected = devices.find((d) => d.id === value) ?? null;

  function handleValueChange(next: string) {
    if (next === UNASSIGNED_VALUE) {
      onChange(null);
    } else {
      onChange(next);
    }
  }

  return (
    <Select
      value={value ?? UNASSIGNED_VALUE}
      onValueChange={handleValueChange}
      disabled={disabled || isEmpty}
    >
      <SelectTrigger
        className="w-full"
        aria-describedby={describedBy}
        aria-label={ariaLabel}
      >
        <SelectValue
          placeholder={
            isEmpty ? "No devices on this microgrid yet" : "Unassigned"
          }
        >
          {isEmpty ? (
            <span className="text-muted-foreground">
              No devices on this microgrid yet
            </span>
          ) : selected ? (
            <span className="flex items-center gap-2">
              <Chip tone="neutral" size="sm">
                {humanReadable(selected.device_type)}
              </Chip>
              <span className="text-foreground">{selected.name}</span>
              <span className="text-xs text-muted-foreground">
                · {selected.edge_name}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Unassigned</span>
          )}
        </SelectValue>
      </SelectTrigger>

      <SelectContent className="max-h-[360px]">
        {isEmpty ? (
          <DropdownEmptyState edgesSetupHref={edgesSetupHref} />
        ) : (
          <>
            {/* Sentinel "Unassigned" option — always first, outside groups */}
            <SelectItem value={UNASSIGNED_VALUE} className="py-1.5">
              <span className="text-muted-foreground">Unassigned</span>
            </SelectItem>

            {grouped.map((group) => (
              <SelectGroup key={group.edge_id}>
                <SelectLabel className="bg-muted px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Edge · {group.edge_name}
                </SelectLabel>
                {group.items.map((d) => {
                  const linked = Boolean(d.linkedToHouseholdName);
                  return (
                    <SelectItem
                      key={d.id}
                      value={d.id}
                      disabled={linked}
                      className={cn("py-1.5", linked && "opacity-60")}
                    >
                      <div className="flex flex-col">
                        <span className="flex items-center gap-2">
                          <Chip tone="neutral" size="sm">
                            {humanReadable(d.device_type)}
                          </Chip>
                          <span className="text-foreground">{d.name}</span>
                          {linked && (
                            <span className="text-xs text-muted-foreground">
                              · linked to {d.linkedToHouseholdName}
                            </span>
                          )}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {d.edge_name}
                        </span>
                      </div>
                    </SelectItem>
                  );
                })}
              </SelectGroup>
            ))}
            <div className="border-t border-border bg-muted px-3 py-2 text-[11px] text-muted-foreground">
              Linked devices are managed from the household they&apos;re assigned to.
            </div>
          </>
        )}
      </SelectContent>
    </Select>
  );
}

// ── In-dropdown empty-state ──────────────────────────────────────────────

function DropdownEmptyState({ edgesSetupHref }: { edgesSetupHref: string }) {
  return (
    <div
      role="region"
      aria-label="No devices available"
      className="px-4 py-5 text-center"
    >
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        DEVICES
      </p>
      <h4 className="mt-1 text-sm font-semibold text-foreground">
        No consumption meters yet
      </h4>
      <p className="mt-1.5 text-xs text-muted-foreground">
        Run discovery on this microgrid&apos;s edges to make meters available
        for household assignment.
      </p>
      <Link
        href={edgesSetupHref}
        className="mt-3 inline-flex items-center text-xs font-medium text-primary hover:underline"
      >
        Discover devices →
      </Link>
    </div>
  );
}

// ── Sort + group helpers ─────────────────────────────────────────────────

function groupByEdge(
  devices: DeviceOption[]
): Array<{ edge_id: string; edge_name: string; items: DeviceOption[] }> {
  const map = new Map<
    string,
    { edge_id: string; edge_name: string; items: DeviceOption[] }
  >();
  for (const d of devices) {
    if (!map.has(d.edge_id)) {
      map.set(d.edge_id, {
        edge_id: d.edge_id,
        edge_name: d.edge_name,
        items: [],
      });
    }
    map.get(d.edge_id)!.items.push(d);
  }
  const groups = Array.from(map.values());
  groups.sort((a, b) => a.edge_name.localeCompare(b.edge_name));
  for (const g of groups) {
    g.items.sort((a, b) => {
      const aLinked = Boolean(a.linkedToHouseholdName);
      const bLinked = Boolean(b.linkedToHouseholdName);
      if (aLinked !== bLinked) return aLinked ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
  }
  return groups;
}
