"use client";

/**
 * TimezoneField — billing-timezone selector for the microgrid form (#357,
 * tz-awareness anchor #353).
 *
 * Composition, not a new primitive:
 *   - `<Select>` (src/components/ui/select.tsx) seeded with a shortlist
 *     derived from the microgrid's address (`timezoneShortlist`), "UTC"
 *     first, plus an "Other zone…" row.
 *   - "Other zone…" opens a `<SelectionDialog>` (src/components/ui/
 *     selection-dialog.tsx) with a search input over the full IANA list
 *     (`Intl.supportedValuesOf('timeZone')` — client-side, no payload).
 *   - Every zone label renders via `formatTimezone` (#356):
 *     "Africa/Kampala (UTC+3)". Never a hand-rolled offset string.
 *
 * Safe-default nudge (#357 AC-4): when the address implies a non-UTC zone
 * while the selected value is still UTC, an inline warning-toned nudge
 * offers one-click adoption of the implied zone.
 *
 * Forward-only + seam note (#357 AC-5): in edit mode, once the selection
 * differs from the stored zone, an inline note explains that the change
 * applies from the NEXT billing period, that the transition day may contain
 * a few extra or fewer hours, and that closed periods keep their stamped
 * zone.
 */

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SelectionDialog } from "@/components/ui/selection-dialog";
import { Input } from "@/components/ui/input";
import { formatTimezone } from "@/components/format/timezone";
import {
  timezoneShortlist,
  impliedNonUtcZone,
  type ShortlistInput,
} from "@/lib/timezone/shortlist";

// Sentinel Select value for the full-list dialog row. Not a zone; never
// persisted — onValueChange intercepts it before it reaches form state.
const OTHER_SENTINEL = "__other_zone__";

export interface TimezoneFieldProps {
  /** Currently selected IANA zone id. */
  value: string;
  onChange: (tz: string) => void;
  /** Address signals for the shortlist + nudge derivation. */
  address: ShortlistInput;
  /**
   * The stored (persisted) zone, when editing an existing microgrid.
   * Drives the forward-only seam note (shown once value !== storedValue).
   * Omit in create mode — a new microgrid has no periods to seam.
   */
  storedValue?: string;
  disabled?: boolean;
  error?: string;
}

export function TimezoneField({
  value,
  onChange,
  address,
  storedValue,
  disabled,
  error,
}: TimezoneFieldProps) {
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [query, setQuery] = React.useState("");

  const shortlist = React.useMemo(() => {
    const list = timezoneShortlist(address);
    // The current value must always be present so the Select can display it,
    // even when it came from the full-list dialog (or a stale address).
    if (value && !list.includes(value)) list.push(value);
    return list;
  }, [address, value]);

  const implied = React.useMemo(
    () => impliedNonUtcZone({ ...address, timezone: value }),
    [address, value],
  );

  const allZones = React.useMemo<string[]>(
    () => ["UTC", ...Intl.supportedValuesOf("timeZone")],
    [],
  );

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return allZones;
    return allZones.filter((z) => z.toLowerCase().includes(q));
  }, [allZones, query]);

  const showSeamNote =
    storedValue !== undefined && value !== storedValue;

  return (
    <div>
      <label
        htmlFor="entity-timezone"
        className="mb-1 block text-xs font-medium text-muted-foreground"
      >
        Billing timezone
      </label>
      <Select
        value={value}
        onValueChange={(v) => {
          if (v === OTHER_SENTINEL) {
            // Intercept the sentinel: open the full-list dialog instead of
            // committing a value. The controlled `value` prop is unchanged,
            // so the trigger keeps displaying the current zone.
            setQuery("");
            setDialogOpen(true);
            return;
          }
          onChange(v);
        }}
        disabled={disabled}
      >
        <SelectTrigger id="entity-timezone" className="w-full">
          <SelectValue>{formatTimezone(value)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {shortlist.map((z) => (
            <SelectItem key={z} value={z}>
              {formatTimezone(z)}
            </SelectItem>
          ))}
          <SelectSeparator />
          <SelectItem value={OTHER_SENTINEL}>Other zone…</SelectItem>
        </SelectContent>
      </Select>
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive-fg">
          {error}
        </p>
      )}

      {/* Safe-default nudge — address implies non-UTC, value still UTC. */}
      {implied && !disabled && (
        <div
          role="status"
          className="mt-2 rounded-md bg-warning-muted p-3 text-xs leading-relaxed text-warning-fg"
        >
          <p>
            {address.address_country?.trim() ? (
              <>This microgrid&apos;s address is in {address.address_country.trim()}, which suggests {formatTimezone(implied)},</>
            ) : (
              <>This microgrid&apos;s location suggests {formatTimezone(implied)},</>
            )}{" "}
            but its billing timezone is {formatTimezone("UTC")} — set it?
          </p>
          <button
            type="button"
            onClick={() => onChange(implied)}
            className="mt-2 inline-flex items-center rounded-md border border-warning px-2.5 py-1 text-xs font-medium text-warning-fg hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Use {formatTimezone(implied)}
          </button>
        </div>
      )}

      {/* Forward-only + seam note — shown at the point of change. */}
      {showSeamNote && (
        <p
          role="note"
          className="mt-2 rounded-md bg-muted p-3 text-xs leading-relaxed text-muted-foreground"
        >
          Changing the billing timezone moves the day boundary starting with
          the <span className="font-medium text-foreground">next</span>{" "}
          billing period — the first period after the change may span a few
          extra or fewer hours on its transition day. Existing periods,
          including closed ones, keep the timezone they were created with.
        </p>
      )}

      {/* Full IANA list — search + pick. */}
      <SelectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="Choose a timezone"
        description="Search the full IANA timezone list."
        footer={
          <button
            type="button"
            onClick={() => setDialogOpen(false)}
            className="inline-flex h-8 items-center rounded-md px-3.5 text-[13px] font-medium text-foreground hover:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Cancel
          </button>
        }
      >
        <div className="sticky top-0 bg-card pb-2 pt-1">
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search zones — e.g. Kampala, Nairobi, Berlin…"
            aria-label="Search timezones"
          />
        </div>
        {filtered.length === 0 ? (
          <p className="py-4 text-muted-foreground">
            No zones match &lsquo;{query}&rsquo;.
          </p>
        ) : (
          <ul className="space-y-0.5">
            {filtered.map((z) => (
              <li key={z}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(z);
                    setDialogOpen(false);
                  }}
                  aria-current={z === value ? "true" : undefined}
                  className="flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left text-sm text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span>{formatTimezone(z)}</span>
                  {z === value && (
                    <span aria-hidden="true" className="text-muted-foreground">
                      ✓
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SelectionDialog>
    </div>
  );
}
