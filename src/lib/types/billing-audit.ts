/**
 * billing-audit.ts — types for the billing audit trail (#173, BC1).
 *
 * Two surfaces consume these:
 *   1. The internal RPC writer (fn_record_line_item_with_audit) — needs the
 *      `LineItemRegeneratedDetails` shape so the route handler can pre-build
 *      the `details` JSONB before calling RPC.
 *   2. The audit-log read endpoint (GET /api/billing-periods/[id]/audit-log)
 *      — UNIONs `billing_audit_log` rows with `payment_events` rows and
 *      surfaces a normalized `BillingAuditLogEntry` shape to BC4.
 *
 * `payment_status_changed` and `payment_link_generated` are NOT in
 * `billing_audit_event_type` (the Postgres enum) — they live exclusively in
 * `payment_events` (00028) and are mapped at read time. They appear in
 * `BillingAuditEventType` here because the read endpoint emits them.
 */

import type { Database } from "./database.gen";

// ── Database-enum-backed event type (write surface) ─────────────────────────

/** Event types that the `billing_audit_log` table itself stores. Subset of
 * `BillingAuditEventType` — see header comment. */
export type DbBillingAuditEventType =
  Database["public"]["Enums"]["billing_audit_event_type"];

// ── Read-endpoint event type (UNION of audit_log + payment_events) ──────────

/**
 * Event types surfaced by GET /api/billing-periods/[id]/audit-log.
 *
 * Includes:
 *   - All `billing_audit_event_type` enum values (this ticket's append-only
 *     audit table writes these).
 *   - `payment_status_changed` and `payment_link_generated` — derived from
 *     `payment_events` rows at read time. NOT in the SQL enum.
 */
export type BillingAuditEventType =
  | DbBillingAuditEventType
  | "payment_status_changed"
  | "payment_link_generated";

// ── details JSONB shapes ────────────────────────────────────────────────────

/**
 * Shape of `billing_audit_log.details` for the
 * `line_item_generated` / `line_item_regenerated` event types. Pre-built by
 * the route handler and passed verbatim to fn_record_line_item_with_audit's
 * `_audit_details` parameter (the SQL function appends `period_was_closed`
 * when applicable).
 */
export type LineItemRegeneratedDetails = {
  /** household.display_name snapshotted at write time — survives line-item delete. */
  household_name: string;
  /** total_amount on the previous (pre-write) line item, NULL when it was an INSERT. */
  previous_total_amount: number | null;
  /** total_amount on the post-write line item. */
  new_total_amount: number;
  /** reading_source on the previous (pre-write) line item, NULL when it was an INSERT. */
  previous_reading_source: "edge" | "manual" | null;
  /** reading_source on the post-write line item. */
  new_reading_source: "edge" | "manual";
  /** present only when new_reading_source === 'manual' AND a non-empty reason was supplied. */
  manual_reason?: string;
  /** added by fn_record_line_item_with_audit (NOT by the route handler) when
   *  the period.status was 'closed' at write time. Absent otherwise. */
  period_was_closed?: true;
};

// ── Read-endpoint entry shape ───────────────────────────────────────────────

/**
 * Normalized audit-log entry returned by GET
 * /api/billing-periods/[periodId]/audit-log.
 *
 * Sources:
 *   - `billing_audit_log` rows for `period_*` and `line_item_*` events.
 *   - `payment_events` rows for `payment_status_changed` /
 *     `payment_link_generated` (mapped from `from_status → to_status` pairs
 *     and source='generate_link').
 *
 * `id` is prefixed (`audit:<uuid>` or `payment_event:<uuid>`) so React keys
 * are stable across the union and so a future "group by source" UI doesn't
 * need a schema change.
 */
export type BillingAuditLogEntry = {
  id: string;
  eventType: BillingAuditEventType;
  actorUserId: string | null;
  actorDisplayName: string | null;
  createdAt: string;
  billingLineItemId: string | null;
  householdName: string | null;
  details: Record<string, unknown>;
};
