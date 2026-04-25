/**
 * audit-humanize.ts — per-event-type renderers for the BC4 audit history (#176).
 *
 * Single entry point: `humanizeAuditEvent(entry)` returns
 *   { label, summary?, manualReason?, postCloseRevision }
 * — JSX (ReactNode) so `<Currency>` and `<StatusChip>` render inline.
 *
 * 6 event types (per the BC1 type module):
 *   - period_created           → label only.
 *   - period_closed            → label only.
 *   - line_item_generated      → label "Bill generated for {hh}", summary "Total: {amount}".
 *   - line_item_regenerated    → label "Bill regenerated for {hh}", summary "Total changed from {prev} to {new}"
 *                                 (or "Total unchanged"), optional source-change clause.
 *   - payment_status_changed   → label "Payment status for {hh}", summary "{from chip} → {to chip}"
 *                                 (or "Set to {to}" when from === null), optional notes line.
 *   - payment_link_generated   → label "Payment link generated for {hh}", no summary.
 *
 * Actor naming (3-state) is handled by `actorDisplayLabel(entry)` rather
 * than baked into the per-type renderers — the renderers don't need to
 * know about actors at all (the list component renders the name beside
 * the label).
 */

import * as React from "react";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";
import { Currency } from "@/components/format/currency";
import { StatusChip } from "@/components/ui/status-chip";
import { Chip } from "@/components/ui/chip";

export type HumanizedAuditEvent = {
  /** "Bill regenerated for HH-A", "Period closed", etc. May contain JSX. */
  label: React.ReactNode;
  /** Optional one-line human summary built from `details`. */
  summary?: React.ReactNode;
  /** Optional indented italic muted note (currently `details.manual_reason`). */
  manualReason?: string;
  /** True when `details.period_was_closed === true` — list renders a warn chip. */
  postCloseRevision: boolean;
};

// ── Actor naming (3-state) ─────────────────────────────────────────────────
//
// Per ticket AC3:
//   - actorUserId === null                                 → "System"
//     (background job / DB default — no human triggered this)
//   - actorUserId !== null && actorDisplayName === null    → "Restricted"
//     (super_admin hidden by user_can_see_user_profile per 00012:71-76;
//     do NOT use "Unknown" — that misleads org_managers into thinking
//     the actor is unidentifiable rather than deliberately not-shown)
//   - actorDisplayName !== null                            → verbatim
export function actorDisplayLabel(entry: BillingAuditLogEntry): string {
  if (entry.actorUserId === null) return "System";
  if (entry.actorDisplayName === null) return "Restricted";
  return entry.actorDisplayName;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function resolveHouseholdName(entry: BillingAuditLogEntry): string {
  // AC4: live join (entry.householdName) → snapshot (details.household_name)
  // → "Unknown household". The fetch helper already collapses live → snapshot
  // into entry.householdName, but we re-check details defensively.
  if (entry.householdName) return entry.householdName;
  const snap = entry.details?.["household_name"];
  if (typeof snap === "string" && snap.length > 0) return snap;
  return "Unknown household";
}

function isPostCloseRevision(entry: BillingAuditLogEntry): boolean {
  // The DB writer (fn_record_line_item_with_audit) only sets this on
  // line_item_generated / line_item_regenerated, but checking generically
  // costs nothing and future-proofs.
  return entry.details?.["period_was_closed"] === true;
}

function getNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ── Per-event-type renderers ───────────────────────────────────────────────

export function humanizeAuditEvent(
  entry: BillingAuditLogEntry
): HumanizedAuditEvent {
  const post = isPostCloseRevision(entry);

  switch (entry.eventType) {
    case "period_created":
      return { label: "Period created", postCloseRevision: post };

    case "period_closed":
      return { label: "Period closed", postCloseRevision: post };

    case "line_item_generated": {
      const hh = resolveHouseholdName(entry);
      const newTotal = getNumber(entry.details?.["new_total_amount"]);
      const summary =
        newTotal !== null ? (
          <>
            Total: <Currency value={newTotal} />
          </>
        ) : undefined;
      return {
        label: `Bill generated for ${hh}`,
        summary,
        manualReason: getString(entry.details?.["manual_reason"]) ?? undefined,
        postCloseRevision: post,
      };
    }

    case "line_item_regenerated": {
      const hh = resolveHouseholdName(entry);
      const prevTotal = getNumber(entry.details?.["previous_total_amount"]);
      const newTotal = getNumber(entry.details?.["new_total_amount"]);
      const prevSrc = getString(entry.details?.["previous_reading_source"]);
      const newSrc = getString(entry.details?.["new_reading_source"]);

      // Per ticket AC4:
      //   - prevTotal === null (INSERT path replayed as regenerate; guard
      //     even though BC1 INSERT path doesn't write this) → "Total unchanged"
      //   - prevTotal === newTotal → "Total unchanged"
      //   - else "Total changed from <prev> to <new>"
      let totalNode: React.ReactNode;
      if (prevTotal === null || newTotal === null || prevTotal === newTotal) {
        totalNode = <>Total unchanged</>;
      } else {
        totalNode = (
          <>
            Total changed from <Currency value={prevTotal} /> to{" "}
            <Currency value={newTotal} />
          </>
        );
      }

      // Source-change clause: only when both non-null AND they differ.
      // Per AC4: when previous_reading_source === null (INSERT path), do
      // NOT render the clause.
      let sourceNode: React.ReactNode = null;
      if (prevSrc !== null && newSrc !== null && prevSrc !== newSrc) {
        sourceNode = (
          <>
            {" · Source changed from "}
            {prevSrc}
            {" to "}
            {newSrc}
          </>
        );
      }

      return {
        label: `Bill regenerated for ${hh}`,
        summary: (
          <>
            {totalNode}
            {sourceNode}
          </>
        ),
        manualReason: getString(entry.details?.["manual_reason"]) ?? undefined,
        postCloseRevision: post,
      };
    }

    case "payment_status_changed": {
      const hh = resolveHouseholdName(entry);
      const from = getString(entry.details?.["from"]);
      const to = getString(entry.details?.["to"]);
      const notes = getString(entry.details?.["notes"]);

      let summary: React.ReactNode;
      if (from === null && to !== null) {
        // Initial assignment — no prior status to compare to.
        summary = (
          <>
            Set to{" "}
            <StatusChip kind="billingLineItemPaymentStatus" status={to} />
          </>
        );
      } else if (to !== null) {
        // Defensive: if the schema ever surfaces an unknown status string,
        // <StatusChip> already falls back to a neutral chip + dev warning.
        summary = (
          <>
            <StatusChip
              kind="billingLineItemPaymentStatus"
              status={from ?? "unpaid"}
            />
            {" → "}
            <StatusChip kind="billingLineItemPaymentStatus" status={to} />
          </>
        );
      } else {
        summary = undefined;
      }

      return {
        label: `Payment status for ${hh}`,
        summary: (
          <>
            {summary}
            {notes && (
              <span className="mt-1 block text-xs italic text-muted-foreground">
                {notes}
              </span>
            )}
          </>
        ),
        postCloseRevision: post,
      };
    }

    case "payment_link_generated": {
      const hh = resolveHouseholdName(entry);
      return {
        label: `Payment link generated for ${hh}`,
        postCloseRevision: post,
      };
    }

    default: {
      // Defensive fallback for an unknown future event type. We keep the
      // raw eventType string so super_admin debugging still has a foothold.
      const exhaustive: never = entry.eventType;
      return {
        label: (
          <span className="font-mono text-xs">
            {(exhaustive as string) || "unknown_event"}
          </span>
        ),
        postCloseRevision: post,
      };
    }
  }
}

// ── Post-close-revision chip (rendered by the list component) ──────────────
//
// Exported so the list can render it next to the event label without
// importing Chip directly.
export function PostCloseRevisionChip() {
  return <Chip tone="warn">post-close revision</Chip>;
}
