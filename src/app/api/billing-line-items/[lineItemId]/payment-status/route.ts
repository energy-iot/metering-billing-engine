/**
 * PATCH /api/billing-line-items/[lineItemId]/payment-status
 *
 * Manual mark-paid / mark-unpaid for a single billing_line_items row.
 * Enforces the operator-tier state machine: unpaid↔paid, failed→paid.
 *
 * Path chain:
 *   lineItem → billing_periods(microgrid_id, start_date, end_date)
 *            → microgrids(id) → households(display_name)
 *
 * Permission:
 *   Both super_admin AND org_manager may trigger manual mark-paid.
 *   (This is an operational reconciliation action, not an admin-only config.)
 *
 * Body:
 *   { status: 'unpaid' | 'paid', notes?: string (≤500 chars) }
 *   'failed' / 'refunded' in body → 400 invalid_body (IPN / refund domain).
 *   Notes are trimmed server-side; empty string after trim → stored as NULL.
 *
 * Response:
 *   200 → { status: 'success', line_item: <updated row with all 4 payment cols> }
 *   400 → { error, reason: 'invalid_body' | 'no_op' | 'invalid_transition' }
 *   403 → { error, reason: 'forbidden' }
 *   404 → { error, reason: 'not_found' }
 *   500 → { error, reason: 'invariant_violation' | 'unknown_error' }
 *
 * Structured logging:
 *   Logs `payment.manual_mark` with notes_present: boolean.
 *   Raw notes are NEVER logged — they may contain PII / receipt references.
 *   No scrubSecretValues needed: this route touches no credentials.
 *   notes_present is booleanised so the log pipeline can be audited for
 *   usage patterns without surfacing any customer data.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import {
  assertValidManualTransition,
  PaymentTransitionError,
  type PaymentStatus,
} from "@/lib/payments/state";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ALLOWED_BODY_STATUSES: readonly string[] = ["unpaid", "paid"];

// ── Body type ─────────────────────────────────────────────────────────────────

type ParsedBody = {
  status: "unpaid" | "paid";
  notes: string | null; // trimmed; null when empty
};

// ── Scope type (query result) ─────────────────────────────────────────────────

type LineItemScopeRow = {
  id: string;
  payment_status: string;
  billing_period_id: string;
  billing_periods:
    | {
        id: string;
        microgrid_id: string;
        start_date: string;
        end_date: string;
      }
    | null;
  households: { display_name: string } | null;
};

// ── Handler ───────────────────────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> },
): Promise<NextResponse> {
  const { lineItemId } = await params;

  // UUID guard.
  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json(
      { error: "Invalid line item id — expected UUID.", reason: "bad_request" },
      { status: 400 },
    );
  }

  // 1. Parse + validate body.
  let parsed: ParsedBody;
  try {
    parsed = await parseBody(request);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Invalid request body.";
    return NextResponse.json(
      { error: msg, reason: "invalid_body" },
      { status: 400 },
    );
  }

  const supabase = await createClient();

  // 2. Resolve lineItem → period + household in one query.
  //    RLS applies: RLS-hidden row surfaces as null → 404.
  const { data: scoped, error: scopedErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
      payment_status,
      billing_period_id,
      billing_periods!inner (
        id,
        microgrid_id,
        start_date,
        end_date
      ),
      households!inner (
        display_name
      )
    `,
    )
    .eq("id", lineItemId)
    .maybeSingle<LineItemScopeRow>();

  if (scopedErr) {
    return NextResponse.json(
      { error: "Failed to look up billing line item.", reason: "unknown_error" },
      { status: 500 },
    );
  }
  if (!scoped) {
    return NextResponse.json(
      { error: "Billing line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  // PostgREST may return joined singletons as single-element arrays; normalize.
  const period = Array.isArray(scoped.billing_periods)
    ? scoped.billing_periods[0]
    : scoped.billing_periods;

  if (!period) {
    return NextResponse.json(
      { error: "Billing line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  const microgridId = period.microgrid_id;

  // 3. Permission gate.
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return NextResponse.json(
      { error: "You do not have permission to update this line item.", reason: "forbidden" },
      { status: 403 },
    );
  }

  // 3a. Resolve actor user ONCE — used for both the paid audit trail and the
  //     structured log. Single fetch avoids the double-getUser() pattern and
  //     guarantees the same identity is written to the DB and emitted to logs.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorUserId: string | null = user?.id ?? null;

  // 4. State transition validation.
  const currentStatus = scoped.payment_status as PaymentStatus;
  try {
    assertValidManualTransition(currentStatus, parsed.status);
  } catch (err) {
    if (err instanceof PaymentTransitionError) {
      const message =
        err.reason === "no_op"
          ? "Bill is already in that state."
          : "That status change is not allowed for manual edits.";
      return NextResponse.json(
        { error: message, reason: err.reason },
        { status: 400 },
      );
    }
    throw err;
  }

  // 5. Build the UPDATE payload.
  //    • *→paid: set all 4 fields atomically.
  //    • paid→unpaid: clear all audit fields — no stale attribution.
  let updatePayload: Record<string, unknown>;

  if (parsed.status === "paid") {
    // Guard: the DB CHECK constraint (billing_line_items_payment_audit_fields_required)
    // requires paid_by_user_id to be non-NULL when payment_status = 'paid'.
    // If auth.getUser() returned null (degraded/expired session), fail fast here
    // with a user-actionable 401 rather than letting the UPDATE reach the DB and
    // surface as an opaque 500 invariant_violation.
    if (!actorUserId) {
      return NextResponse.json(
        { error: "Session expired. Please reload and try again.", reason: "session_expired" },
        { status: 401 },
      );
    }

    updatePayload = {
      payment_status: "paid",
      paid_at: new Date().toISOString(),
      paid_by_user_id: actorUserId,
      payment_notes: parsed.notes,
    };
  } else {
    // paid → unpaid: clear everything. The CHECK constraint will reject any
    // row where unpaid is set with non-NULL audit fields.
    updatePayload = {
      payment_status: "unpaid",
      paid_at: null,
      paid_by_user_id: null,
      payment_notes: null,
    };
  }

  // 6. Atomic UPDATE + return the full updated row.
  const { data: updated, error: updateErr } = await supabase
    .from("billing_line_items")
    .update(updatePayload)
    .eq("id", lineItemId)
    .select()
    .single();

  if (updateErr) {
    // PostgreSQL constraint violation (23514 = check_violation).
    const isCheckViolation = updateErr.code === "23514";
    console.error(
      JSON.stringify({
        event: "payment.manual_mark.error",
        line_item_id: lineItemId,
        microgrid_id: microgridId,
        from_status: currentStatus,
        to_status: parsed.status,
        reason: isCheckViolation ? "invariant_violation" : "update_error",
        pg_code: updateErr.code,
        at: new Date().toISOString(),
      }),
    );
    return NextResponse.json(
      {
        error: isCheckViolation
          ? "Internal constraint violation. Contact support."
          : "Failed to update payment status.",
        reason: isCheckViolation ? "invariant_violation" : "unknown_error",
      },
      { status: 500 },
    );
  }

  // 7. Structured log.
  //
  // IMPORTANT: raw `notes` text is NEVER logged — it may contain PII or
  // receipt references (e.g. "M-Pesa receipt #KJ3F456", customer name).
  // We log `notes_present: boolean` only so the log pipeline can audit
  // usage frequency without surfacing customer data.
  //
  // No scrubSecretValues needed: this route does not touch any credentials
  // (no payment provider secret, no AWS key). The deliberate omission is
  // documented here so a future reader can verify the decision was conscious.
  //
  // actorUserId was resolved once at step 3a — reused here, no second getUser().

  console.info(
    JSON.stringify({
      event: "payment.manual_mark",
      line_item_id: lineItemId,
      microgrid_id: microgridId,
      actor_user_id: actorUserId,
      from_status: currentStatus,
      to_status: parsed.status,
      notes_present: parsed.notes !== null, // booleanised — see comment above
      at: new Date().toISOString(),
    }),
  );

  return NextResponse.json({ status: "success", line_item: updated });
}

// ── Body parser ───────────────────────────────────────────────────────────────

async function parseBody(request: NextRequest): Promise<ParsedBody> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new Error("Request body must be valid JSON.");
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Request body must be a JSON object.");
  }

  const raw = body as Record<string, unknown>;

  // status — required; only 'unpaid' | 'paid' accepted from clients.
  // 'failed' and 'refunded' are IPN/refund-flow domain — rejected here so
  // the transition matrix never sees them from a manual PATCH.
  if (!("status" in raw)) {
    throw new Error("Missing required field: status.");
  }
  if (!ALLOWED_BODY_STATUSES.includes(raw.status as string)) {
    throw new Error(
      `Invalid status '${raw.status}'. Manual edits accept only 'unpaid' or 'paid'.`,
    );
  }

  // notes — optional; string, max 500 chars after trim.
  let notes: string | null = null;
  if ("notes" in raw && raw.notes !== undefined && raw.notes !== null) {
    if (typeof raw.notes !== "string") {
      throw new Error("notes must be a string.");
    }
    const trimmed = raw.notes.trim();
    if (trimmed.length > 500) {
      throw new Error("notes must be 500 characters or fewer.");
    }
    notes = trimmed.length > 0 ? trimmed : null;
  }

  return { status: raw.status as "unpaid" | "paid", notes };
}
