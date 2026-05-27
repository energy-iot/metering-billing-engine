import { NextRequest, NextResponse } from "next/server";
import {
  resolveMicrogridOrgId,
  resolveOrgFromToken,
} from "@/lib/internal-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { HOUSEHOLD_PUBLIC_COLUMNS_FOR_CUSTOMERAPP } from "@/lib/types/household-columns";

/**
 * GET /api/v1/microgrids/:microgrid_id/households — discovery endpoint (#257).
 *
 * Returns the households on a microgrid the per-org API token can access,
 * so customerapp can resolve household UUIDs programmatically.
 *
 * Response shape:
 *   200 OK  →  [{ id, display_name, microgrid_id, has_device }, …]
 *              (empty array if the microgrid has zero households)
 *   400     →  malformed `:microgrid_id` UUID
 *   401     →  auth failure (missing / malformed / unknown / revoked token)
 *   403     →  microgrid exists but belongs to a different org than the
 *              token; OR `customerapp_enabled = FALSE` for the token's org
 *              (the latter gated inside `resolveOrgFromToken` per #251).
 *   404     →  `:microgrid_id` doesn't exist anywhere
 *
 * Ordering of the 403-vs-404 distinction is load-bearing: the 404 fires
 * BEFORE the org-equality check, so a non-existent UUID never reveals
 * "exists in some other org". `resolveMicrogridOrgId` enforces this by
 * resolving (or 404-ing) first; the 403 is then a deliberate per-route
 * comparison against `auth.org_id`. Matches the 2026-04 permission-before-
 * target-lookup learning and the pattern landed by #254.
 *
 * `has_device` is computed in JS from a `household_devices(device_id)`
 * embed — no `has_device` column exists on `households`. The truthy check
 * is `row.household_devices && row.household_devices.length > 0`. A future
 * promotion to a SECURITY DEFINER RPC (`fn_list_microgrid_households`) is
 * tracked as a follow-up if performance characterization warrants it.
 *
 * Explicit column enumeration via `HOUSEHOLD_PUBLIC_COLUMNS_FOR_CUSTOMERAPP`
 * — never `select("*")`. Enforced by
 * `src/lib/__tests__/no-household-star-select-customerapp.test.ts` (scoped
 * to `src/app/api/v1/` only — operator-side `households` queries are not
 * restricted).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ microgrid_id: string }> },
) {
  const auth = await resolveOrgFromToken(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  const { microgrid_id } = await params;

  const supabase = createServiceClient();

  // Resolve to 404 BEFORE comparing to the token's org (UUID-enumeration
  // defense — see comment above).
  const resolved = await resolveMicrogridOrgId(supabase, microgrid_id);
  if (!resolved.ok) {
    return NextResponse.json(
      { error: resolved.reason },
      { status: resolved.status },
    );
  }

  if (resolved.org_id !== auth.org_id) {
    return NextResponse.json(
      { error: "microgrid_not_in_org" },
      { status: 403 },
    );
  }

  const { data, error } = await supabase
    .from("households")
    .select(
      `${HOUSEHOLD_PUBLIC_COLUMNS_FOR_CUSTOMERAPP}, household_devices(device_id)`,
    )
    .eq("microgrid_id", microgrid_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []).map((h) => {
    const hd = (h as { household_devices?: unknown }).household_devices;
    const has_device = Array.isArray(hd) && hd.length > 0;
    return {
      id: (h as { id: string }).id,
      display_name: (h as { display_name: string }).display_name,
      microgrid_id: (h as { microgrid_id: string }).microgrid_id,
      has_device,
    };
  });

  return NextResponse.json(rows);
}
