/**
 * audit-log-fetch.ts — shared loader for the period audit log (#176, BC4).
 *
 * Lifted verbatim from the BC1 route handler
 * (`src/app/api/billing-periods/[periodId]/audit-log/route.ts`) so two
 * surfaces share one implementation:
 *
 *   1. The HTTP endpoint (BC1) — `GET /api/billing-periods/[id]/audit-log`
 *      delegates to `fetchAuditLogEntries`. Existing route tests at
 *      `route.test.ts` are the behavior contract — DO NOT diverge.
 *   2. The server-rendered history page (BC4) —
 *      `src/app/(dashboard)/microgrids/[id]/billing/[periodId]/history/page.tsx`
 *      calls this directly under the user-bound supabase client. No HTTP
 *      fetch from a server component (cookie + absolute-URL footgun).
 *
 * Behavior preserved (any change here will break the BC1 contract):
 *   - LIMIT 500 per side (memory-safety guard, NOT pagination).
 *   - `payment_events.at` aliased into the entry's `createdAt`.
 *   - `user_directory` join surfaces actor display names; missing rows
 *     (RLS-hidden super_admin per `user_can_see_user_profile`) → null.
 *   - `actorDisplayName` = first+last, fallback email, fallback null.
 *   - Audit IDs prefixed `audit:<uuid>`; payment-event IDs prefixed
 *     `payment_event:<uuid>` for stable React keys across the union.
 *   - Audit-row householdName resolution: live join (`billing_line_items
 *     → households`) preferred over the snapshot in `details.household_name`;
 *     snapshot used when the line item is hard-deleted (FK NULL).
 *
 * The result discriminator mirrors the `unauthorized` / `not-found` /
 * `error` / `ok` shape the route needs to map to HTTP status codes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";

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

export type AuditLogFetchResult =
  | { kind: "ok"; entries: BillingAuditLogEntry[] }
  | { kind: "unauthorized" }
  | { kind: "not_found" }
  | { kind: "error"; message: string };

/**
 * Fetch the merged audit log for one billing period under the supplied
 * (user-bound) supabase client. Caller is responsible for routing the
 * discriminated result to a 200 / 401 / 404 / 500 response (HTTP) or
 * to the appropriate page-level rendering branch (server component).
 */
export async function fetchAuditLogEntries(
  // We intentionally use a wide SupabaseClient typing here — the Database
  // generic on the route's createClient() is unnecessary plumbing for a
  // helper that only does table selects with explicit column lists.
  supabase: SupabaseClient,
  periodId: string
): Promise<AuditLogFetchResult> {
  // Explicit auth gate — every other route in this ticket also has it.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { kind: "unauthorized" };
  }

  // Verify the period exists + caller can see it (RLS gates the query).
  const { data: period, error: periodErr } = await supabase
    .from("billing_periods")
    .select("id")
    .eq("id", periodId)
    .maybeSingle<{ id: string }>();

  if (periodErr) {
    return {
      kind: "error",
      message: `Failed to look up billing period: ${periodErr.message}`,
    };
  }
  if (!period) {
    return { kind: "not_found" };
  }

  // ── 1. Read billing_audit_log (BC1's table) ───────────────────────────────
  const { data: auditRowsRaw, error: auditErr } = await supabase
    .from("billing_audit_log")
    .select(
      "id, billing_period_id, billing_line_item_id, event_type, actor_user_id, created_at, details"
    )
    .eq("billing_period_id", periodId)
    .order("created_at", { ascending: false })
    .limit(PER_SIDE_LIMIT);

  if (auditErr) {
    return {
      kind: "error",
      message: `Failed to read audit log: ${auditErr.message}`,
    };
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
    return {
      kind: "error",
      message: `Failed to read payment events: ${peErr.message}`,
    };
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

  return { kind: "ok", entries };
}
