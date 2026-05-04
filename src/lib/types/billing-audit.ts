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
  /** present only when new_reading_source === 'manual' AND a non-empty reason was supplied.
   *  This is the NEW manual reason; the PREVIOUS reason lives in
   *  previous_snapshot.manual_reason (see below). */
  manual_reason?: string;
  /** added by fn_record_line_item_with_audit (NOT by the route handler) when
   *  the period.status was 'closed' at write time. Absent otherwise. */
  period_was_closed?: true;
  /** Snapshot of the reading-side fields on the row immediately BEFORE this
   *  regeneration overwrote them. Present only on UPDATE (when prior exists);
   *  absent on fresh INSERT. Optional for backward-compat with audit rows
   *  written before this field was introduced (#218).
   *
   *  Provenance: added by the CALLER (runGenerationFor) before the RPC
   *  call, NOT by the RPC. Contrast `period_was_closed` above, which is
   *  added by the RPC (00029:291 jsonb merge). Both keys land in the
   *  same JSONB blob. */
  previous_snapshot?: PreviousReadingSnapshot;
};

/** Pre-overwrite snapshot of the reading-side columns on a billing_line_items
 *  row. Captured by runGenerationFor and persisted into
 *  billing_audit_log.details.previous_snapshot for line_item_regenerated
 *  events. Numerics are coerced to JS Number to match the existing
 *  previous_total_amount pattern (see #218 Dev Notes for precision tradeoff). */
export type PreviousReadingSnapshot = {
  /** previous billing_line_items.start_kwh (NUMERIC → JS Number) */
  start_kwh: number | null;
  /** previous billing_line_items.end_kwh (NUMERIC → JS Number) */
  end_kwh: number | null;
  /** previous billing_line_items.usage_kwh (NUMERIC → JS Number) */
  usage_kwh: number | null;
  /** previous billing_line_items.tier_breakdown (JSONB; opaque, persisted as-is).
   *  Type intentionally `unknown` — the audit contract is "round-trip the
   *  JSONB blob unchanged", we don't validate the per-tier shape here.
   *  If a future consumer needs typed access, cast at the consumer
   *  (`as TierBreakdown[]`); do NOT widen this type. */
  tier_breakdown: unknown;
  /** previous billing_line_items.device_id (UUID or NULL when un-metered) */
  device_id: string | null;
  /** previous billing_line_items.entered_by_user_id — who entered the previous
   *  reading. UUID; not PII per the entity model. */
  entered_by_user_id: string | null;
  /** previous billing_line_items.entered_at (ISO TIMESTAMPTZ string or NULL). */
  entered_at: string | null;
  /** previous billing_line_items.manual_reason — the PREVIOUS reason string.
   *  Distinct from the top-level manual_reason which is the NEW reason. */
  manual_reason: string | null;
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
