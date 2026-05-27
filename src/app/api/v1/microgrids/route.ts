import { NextRequest, NextResponse } from "next/server";
import { resolveOrgFromToken } from "@/lib/internal-auth";
import { createServiceClient } from "@/lib/supabase/service";
import { MICROGRID_PUBLIC_COLUMNS_FOR_CUSTOMERAPP } from "@/lib/types/microgrid-columns";

/**
 * GET /api/v1/microgrids — discovery endpoint (#257).
 *
 * Returns the microgrids visible to the per-org API token, so the
 * customerapp integration can resolve UUIDs programmatically instead of
 * hardcoding them. Filtered to the token's org via the
 * `microgrids → communities → org_id` chain (same chain used by RLS helper
 * `user_can_access_microgrid`).
 *
 * Response shape:
 *   200 OK  →  [{ id, name, currency, community_name }, …]   (empty array if zero)
 *   401     →  auth failure (missing / malformed / unknown / revoked token)
 *   403     →  customerapp_enabled = FALSE for the token's org (gated inside
 *              `resolveOrgFromToken` per #251 once that helper lands; until
 *              then the gate is no-op and this branch is unreachable).
 *
 * Empty array vs 404: an empty result means the org has zero microgrids,
 * NOT that the resource is missing — return 200 with `[]`. Reserve 404 for
 * the per-microgrid endpoint where `:id` doesn't exist.
 *
 * Explicit column enumeration via `MICROGRID_PUBLIC_COLUMNS_FOR_CUSTOMERAPP`
 * — never `select("*")`. New sensitive columns added upstream do NOT leak
 * across the customerapp boundary unless explicitly added to that constant.
 * Enforced by `src/lib/__tests__/no-microgrid-star-select.test.ts`.
 */
export async function GET(request: NextRequest) {
  const auth = await resolveOrgFromToken(request);
  if (!auth.ok) {
    return NextResponse.json({ error: auth.reason }, { status: auth.status });
  }

  const supabase = createServiceClient();

  // PostgREST `!inner` filters parent rows by joined-table predicates.
  // `.eq("communities.org_id", auth.org_id)` resolves against the embedded
  // relation's column, scoping the result to the token's org.
  const { data, error } = await supabase
    .from("microgrids")
    .select(
      `${MICROGRID_PUBLIC_COLUMNS_FOR_CUSTOMERAPP}, communities!inner(name, org_id)`,
    )
    .eq("communities.org_id", auth.org_id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Shape the embed back into the flat response contract documented above.
  // `communities` may come back as an object (single inner-join) or an
  // array depending on PostgREST inference; narrow defensively.
  const rows = (data ?? []).map((m) => {
    const communities = (m as { communities: unknown }).communities;
    const community = Array.isArray(communities)
      ? (communities[0] as { name: string } | undefined)
      : (communities as { name: string } | null);
    return {
      id: (m as { id: string }).id,
      name: (m as { name: string }).name,
      currency: (m as { currency: string }).currency,
      community_name: community?.name ?? null,
    };
  });

  return NextResponse.json(rows);
}
