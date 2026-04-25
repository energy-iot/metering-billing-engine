import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { fetchAuditLogEntries } from "@/lib/billing/audit-log-fetch";

/**
 * GET /api/billing-periods/[periodId]/audit-log (#173, BC1)
 *
 * Returns the chronological audit history for a billing period — UNION of:
 *   - billing_audit_log (BC1's append-only table; column `created_at`)
 *   - payment_events    (00028; column is `at`, NOT `created_at`)
 *
 * Both tables are queried under the user-bound supabase client so RLS
 * applies on each. We then merge in memory by createdAt DESC.
 *
 * BC4 (#176) lifted the fetch + normalize logic into
 * `src/lib/billing/audit-log-fetch.ts` so the server-rendered history
 * page can share one implementation. This handler is now a thin wrapper
 * — UUID validation, then `fetchAuditLogEntries`, then map the
 * discriminated result to HTTP. The behavior contract pinned by
 * `__tests__/route.test.ts` is unchanged.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  const result = await fetchAuditLogEntries(supabase, periodId);

  switch (result.kind) {
    case "unauthorized":
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    case "not_found":
      return NextResponse.json(
        { error: "Billing period not found" },
        { status: 404 }
      );
    case "error":
      return NextResponse.json({ error: result.message }, { status: 500 });
    case "ok":
      return NextResponse.json({ entries: result.entries });
  }
}
