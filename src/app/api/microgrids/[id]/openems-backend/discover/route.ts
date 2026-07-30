import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";
import { createOpenEmsClient, OpenEmsError } from "@/lib/openems";
import { getMicrogridEmsConfig } from "@/lib/openems/config";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/microgrids/[id]/openems-backend/discover — Run Discover now.
 *
 * Used by the Add Edge dialog's "Discovering…" state. Authorization is
 * enforced by RLS (getMicrogridEmsConfig can only read visible rows) and
 * — for cloud_aws — by the SECURITY-DEFINER helper fn_get_ems_secret which
 * only decrypts for super_admin / service_role.
 *
 * Returns 409 if ems_type is NULL (microgrid not configured).
 *
 * N+1 avoidance: we prefetch existing edge ids once into a Set, then
 * compute alreadyLinked per discovered edge in O(1).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { id: microgridId } = await params;

  if (!UUID_RE.test(microgridId)) {
    return NextResponse.json(
      { error: "Invalid microgrid id — expected UUID" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // Discover mutates ems_last_discover_* health fields and resolves the
  // decrypted secret via getMicrogridEmsConfig. Gate here so org_managers
  // cannot trigger a write or observe backend connectivity status indirectly
  // through error messages. This gate is in addition to the RLS row read that
  // getEmsSecretForMicrogrid performs before its service-role decrypt.
  if (!(await currentUserIsSuperAdmin(supabase))) {
    return NextResponse.json(
      { error: "Only super admins can run OpenEMS backend discovery." },
      { status: 403 }
    );
  }

  let emsConfig;
  try {
    emsConfig = await getMicrogridEmsConfig(supabase, microgridId);
  } catch (err) {
    if (err instanceof OpenEmsError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode }
      );
    }
    throw err;
  }

  if (!emsConfig) {
    // Either the microgrid is hidden by RLS (cross-org → effectively 404)
    // or ems_type is NULL. We can't tell apart without a second query, so
    // we use a helper lookup. For the "not configured" case, the PM copy
    // says 409; for the "cross-org" case, we return 404 to not leak.
    //
    // Defensive extra probe: try to read the microgrid with RLS. If it
    // resolves, the case is "not configured"; else "hidden/missing."
    const { data: probe } = await supabase
      .from("microgrids")
      .select("id")
      .eq("id", microgridId)
      .maybeSingle();
    if (!probe) {
      return NextResponse.json(
        { error: "Microgrid not found." },
        { status: 404 }
      );
    }
    return NextResponse.json(
      {
        error:
          "OpenEMS Backend not configured. Configure it first on the OpenEMS Backend tab.",
      },
      { status: 409 }
    );
  }

  // Read ems_known_edge_ids via a separate query — deliberately not extending
  // getMicrogridEmsConfig so that helper's responsibility stays scoped to
  // "build a connection config". Catalog data is a separate concern (#112).
  const { data: mgRow } = await supabase
    .from("microgrids")
    .select("ems_known_edge_ids")
    .eq("id", microgridId)
    .maybeSingle<{ ems_known_edge_ids: string[] }>();

  const knownEdgeIds: string[] = mgRow?.ems_known_edge_ids ?? [];

  // Run Discover.
  // Pass knownEdgeIds to getEdgesStatus instead of []. getEdgesStatus([])
  // returns {} on real OpenEMS backends (verified 2026-04-23 against Kisakye);
  // knownEdgeIds is the correct approach (#112).
  //
  // If knownEdgeIds is empty, skip the RPC and return zero_edges immediately
  // (no edges declared yet — user must configure them via the OpenEMS Backend tab).
  let discoverStatus:
    | "success"
    | "auth_failed"
    | "unreachable"
    | "zero_edges"
    | "unknown_error" = "success";
  let discoverMessage = "";
  let discoveredEdges: Array<{
    openems_edge_id: string;
    name: string;
    metadata: Record<string, unknown>;
    alreadyLinked: boolean;
  }> = [];

  if (knownEdgeIds.length === 0) {
    discoverStatus = "zero_edges";
    discoverMessage =
      "No edges declared yet — add some in Reconfigure → Known edge IDs to enable the Add Edge flow.";
  } else {
    try {
      const client = createOpenEmsClient(emsConfig);
      const statuses = await client.getEdgesStatus(knownEdgeIds);

      if (statuses.length === 0) {
        discoverStatus = "zero_edges";
        discoverMessage =
          "Connected, but the OpenEMS Backend returned zero edges. Check that edges are registered under this backend.";
      } else {
        // N+1 avoidance: prefetch existing edge ids once.
        const prefetched = new Set<string>();
        const { data: existing } = await supabase
          .from("edges")
          .select("openems_edge_id")
          .eq("microgrid_id", microgridId);
        for (const e of existing ?? []) {
          if (e.openems_edge_id) prefetched.add(e.openems_edge_id);
        }

        discoveredEdges = statuses.map((s) => ({
          openems_edge_id: s.edgeId,
          name: s.edgeId,
          metadata: { online: s.online },
          alreadyLinked: prefetched.has(s.edgeId),
        }));
        discoverMessage = `Connected. ${discoveredEdges.length} edge${discoveredEdges.length === 1 ? "" : "s"} discovered.`;
      }
    } catch (err) {
      if (err instanceof OpenEmsError) {
        if (err.code === "OPENEMS_AUTH_FAILED") {
          discoverStatus = "auth_failed";
          discoverMessage =
            "Authentication failed. Verify your AWS credentials and region (common cause: rotated access key).";
        } else if (err.code === "OPENEMS_UNREACHABLE") {
          discoverStatus = "unreachable";
          discoverMessage = `Could not reach OpenEMS Backend at ${emsConfig.url}. Check the URL and that the host is reachable from Vercel.`;
        } else {
          discoverStatus = "unknown_error";
          discoverMessage =
            "Discover failed with an unexpected error. Check server logs.";
        }
      } else {
        discoverStatus = "unknown_error";
        discoverMessage =
          "Discover failed with an unexpected error. Check server logs.";
      }
    }
  }

  // Update health fields (non-fatal if it fails).
  await supabase
    .from("microgrids")
    .update({
      ems_last_discover_at: new Date().toISOString(),
      ems_last_discover_status: discoverStatus,
      ems_last_discover_error:
        discoverStatus === "success" ? null : discoverMessage,
      ems_last_discover_count:
        discoverStatus === "success" ? discoveredEdges.length : null,
    })
    .eq("id", microgridId);

  const {
    data: { user },
  } = await supabase.auth.getUser();

  console.info(
    JSON.stringify({
      event: "openems.discover",
      microgrid_id: microgridId,
      actor_user_id: user?.id ?? null,
      result_status: discoverStatus,
      edge_count: discoveredEdges.length,
      duration_ms: Date.now() - startedAt,
      at: new Date().toISOString(),
    })
  );

  return NextResponse.json(
    {
      status: discoverStatus,
      message: discoverMessage,
      edges: discoveredEdges,
    },
    { status: 200 }
  );
}
