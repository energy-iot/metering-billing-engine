import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";

/**
 * GET /api/billing-periods/[periodId]/audit-log (#173, BC1)
 *
 * Returns the chronological audit history for a billing period — UNION of:
 *   - billing_audit_log (this ticket's append-only table; column `created_at`)
 *   - payment_events    (00028; column is `at`, NOT `created_at`)
 *
 * Both tables are queried under the user-bound supabase client so RLS
 * applies on each. We then merge in memory by createdAt DESC.
 *
 * ── Implementer pin: payment_events column is `at` ──────────────────────────
 *
 * `SELECT created_at FROM payment_events` will fail with "column does not
 * exist". The schema is `at TIMESTAMPTZ NOT NULL DEFAULT NOW()` (00028:156).
 * Always alias `at AS created_at` (or read `at` and map to `createdAt` in TS,
 * which is what we do here).
 *
 * ── LIMIT 500 per side ──────────────────────────────────────────────────────
 *
 * Memory-safety guard, NOT pagination. Worst case the response is ~1000
 * rows. If a period legitimately exceeds 500 events on either side, BC4
 * surfaces a "may be truncated" warning banner. Paginate when periods
 * routinely exceed 500 events on either side.
 *
 * ── user_directory RLS implication ──────────────────────────────────────────
 *
 * The `user_directory` view (00014) filters via
 * `user_can_see_user_profile(auth.uid())`. An org_manager looking at an
 * audit entry whose actor is a super_admin (e.g. a cross-org operator) sees
 * `actorDisplayName: null` — the helper hides super_admins from
 * org_managers (00012:71-76). This is intentional: org_managers know
 * "someone with elevated access touched this row" without learning the
 * super_admin's identity.
 *
 * ── Prefixed IDs ────────────────────────────────────────────────────────────
 *
 * `audit:<uuid>` and `payment_event:<uuid>` keep React keys stable across
 * the union (vanishingly unlikely UUID collision but free safety) and leave
 * room for a future "group by source" UX without a schema change.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PER_SIDE_LIMIT = 500;

type AuditRow = {
  id: string;
  billing_period_id: string;
  billing_line_item_id: string | null;
  event_type:
    | "period_created"
    | "period_closed"
    | "line_item_generated"
    | "line_item_regenerated";
  actor_user_id: string | null;
  created_at: string;
  details: Record<string, unknown> | null;
};

type PaymentEventRow = {
  id: string;
  line_item_id: string;
  from_status: string | null;
  to_status: string;
  source: "ipn" | "manual" | "generate_link";
  actor_user_id: string | null;
  raw_payload: Record<string, unknown> | null;
  at: string;
  // Joined billing_line_items for line_item → period scoping + payment_notes.
  billing_line_items: {
    billing_period_id: string;
    payment_notes: string | null;
    households: { display_name: string } | null;
  } | null;
};

type DirectoryRow = {
  user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

function pickDisplayName(row: DirectoryRow | undefined): string | null {
  if (!row) return null;
  const parts = [row.first_name, row.last_name].filter(
    (s): s is string => typeof s === "string" && s.length > 0
  );
  if (parts.length > 0) return parts.join(" ");
  return row.email ?? null;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ periodId: string }> }
): Promise<NextResponse> {
  const { periodId } = await params;

  if (!UUID_RE.test(periodId)) {
    return NextResponse.json(
      { error: "Invalid periodId — expected UUID." },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // Explicit auth gate — every other route in this ticket also has it.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Verify the period exists + caller can see it (RLS gates the query).
  const { data: period, error: periodErr } = await supabase
    .from("billing_periods")
    .select("id")
    .eq("id", periodId)
    .maybeSingle<{ id: string }>();

  if (periodErr) {
    return NextResponse.json(
      { error: `Failed to look up billing period: ${periodErr.message}` },
      { status: 500 }
    );
  }
  if (!period) {
    return NextResponse.json(
      { error: "Billing period not found" },
      { status: 404 }
    );
  }

  // ── 1. Read billing_audit_log (this ticket's table) ───────────────────────
  const { data: auditRowsRaw, error: auditErr } = await supabase
    .from("billing_audit_log")
    .select(
      "id, billing_period_id, billing_line_item_id, event_type, actor_user_id, created_at, details"
    )
    .eq("billing_period_id", periodId)
    .order("created_at", { ascending: false })
    .limit(PER_SIDE_LIMIT);

  if (auditErr) {
    return NextResponse.json(
      { error: `Failed to read audit log: ${auditErr.message}` },
      { status: 500 }
    );
  }
  const auditRows = (auditRowsRaw ?? []) as unknown as AuditRow[];

  // ── 2. Read payment_events for line items in this period ─────────────────
  // Join billing_line_items to scope to this period AND to surface
  // payment_notes + household.display_name for the response.
  const { data: paymentEventsRaw, error: peErr } = await supabase
    .from("payment_events")
    .select(
      `
      id, line_item_id, from_status, to_status, source, actor_user_id,
      raw_payload, at,
      billing_line_items!inner (
        billing_period_id,
        payment_notes,
        households (
          display_name
        )
      )
    `
    )
    .eq("billing_line_items.billing_period_id", periodId)
    .order("at", { ascending: false })
    .limit(PER_SIDE_LIMIT);

  if (peErr) {
    return NextResponse.json(
      { error: `Failed to read payment events: ${peErr.message}` },
      { status: 500 }
    );
  }
  const paymentEvents = (paymentEventsRaw ?? []) as unknown as PaymentEventRow[];

  // ── 3. Resolve household_name for billing_audit_log entries that have a
  //       live billing_line_item_id (preferred over the snapshot). When the
  //       line item is hard-deleted, the FK is NULL and we fall back to
  //       details.household_name (the snapshot kept by the writer).
  const liveLineItemIds = Array.from(
    new Set(
      auditRows
        .map((r) => r.billing_line_item_id)
        .filter((v): v is string => Boolean(v))
    )
  );
  const lineItemNameMap = new Map<string, string | null>();
  if (liveLineItemIds.length > 0) {
    const { data: lis } = await supabase
      .from("billing_line_items")
      .select("id, households(display_name)")
      .in("id", liveLineItemIds);
    type LiHHRow = {
      id: string;
      households: { display_name: string } | { display_name: string }[] | null;
    };
    for (const r of (lis ?? []) as LiHHRow[]) {
      const hh = r.households;
      const name = Array.isArray(hh)
        ? hh[0]?.display_name ?? null
        : hh?.display_name ?? null;
      lineItemNameMap.set(r.id, name);
    }
  }

  // ── 4. Resolve actor display names via user_directory (RLS-aware). ───────
  const actorIds = Array.from(
    new Set(
      [
        ...auditRows.map((r) => r.actor_user_id),
        ...paymentEvents.map((p) => p.actor_user_id),
      ].filter((v): v is string => Boolean(v))
    )
  );
  const directoryMap = new Map<string, DirectoryRow>();
  if (actorIds.length > 0) {
    const { data: dirRows } = await supabase
      .from("user_directory")
      .select("user_id, email, first_name, last_name")
      .in("user_id", actorIds);
    for (const r of (dirRows ?? []) as DirectoryRow[]) {
      directoryMap.set(r.user_id, r);
    }
  }

  // ── 5. Normalize → BillingAuditLogEntry[] ─────────────────────────────────
  const entries: BillingAuditLogEntry[] = [];

  for (const a of auditRows) {
    const detailsObj =
      a.details && typeof a.details === "object" ? a.details : {};
    const snapshotName =
      typeof detailsObj["household_name"] === "string"
        ? (detailsObj["household_name"] as string)
        : null;
    const liveName = a.billing_line_item_id
      ? lineItemNameMap.get(a.billing_line_item_id) ?? null
      : null;
    entries.push({
      id: `audit:${a.id}`,
      eventType: a.event_type,
      actorUserId: a.actor_user_id,
      actorDisplayName: pickDisplayName(
        a.actor_user_id ? directoryMap.get(a.actor_user_id) : undefined
      ),
      createdAt: a.created_at,
      billingLineItemId: a.billing_line_item_id,
      householdName: liveName ?? snapshotName,
      details: detailsObj,
    });
  }

  for (const p of paymentEvents) {
    // PostgREST may surface the !inner join as an array even though it's
    // single-row in the DB — defensive coerce mirrors the PATCH /usage
    // pattern.
    const bli = Array.isArray(p.billing_line_items)
      ? p.billing_line_items[0]
      : p.billing_line_items;
    const hh = bli?.households;
    const householdName = Array.isArray(hh)
      ? hh[0]?.display_name ?? null
      : hh?.display_name ?? null;

    // Map to BC4's normalized event types.
    // - source='generate_link' → payment_link_generated (incl. regenerate
    //   where from === to)
    // - everything else → payment_status_changed
    const eventType: BillingAuditLogEntry["eventType"] =
      p.source === "generate_link"
        ? "payment_link_generated"
        : "payment_status_changed";

    const details: Record<string, unknown> = {
      from: p.from_status,
      to: p.to_status,
      source: p.source,
      raw_payload: p.raw_payload,
    };
    if (bli?.payment_notes) details["notes"] = bli.payment_notes;

    entries.push({
      id: `payment_event:${p.id}`,
      eventType,
      actorUserId: p.actor_user_id,
      actorDisplayName: pickDisplayName(
        p.actor_user_id ? directoryMap.get(p.actor_user_id) : undefined
      ),
      createdAt: p.at,
      billingLineItemId: p.line_item_id,
      householdName,
      details,
    });
  }

  // Merge by createdAt DESC.
  entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  return NextResponse.json({ entries });
}
