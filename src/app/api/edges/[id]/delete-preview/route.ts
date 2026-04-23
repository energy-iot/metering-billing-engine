import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { countEntityDescendants } from "@/lib/entity-descendants";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import {
  UUID_RE,
  errorBody,
  mapPgError,
  resolveParent,
} from "@/lib/entity-deletion/shared";

/**
 * GET /api/edges/[id]/delete-preview — descendant counts for the
 * blast-radius dialog (#89 / AC-ROUTE-3).
 *
 * Permission parity with DELETE: super_admin OR org_manager for the edge's
 * microgrid's parent org (AC-ROUTE-4).
 *
 * Order matters: fetch edge first so a non-existent edge produces 404,
 * not 403 (the `buildDeletePreviewHandler` factory calls canAccess before
 * the entity fetch, which collapses not-found + not-authorized into 403 for
 * edge because we must look up microgrid_id from the edge row itself).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      errorBody("Invalid edge id — expected UUID."),
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // Fetch the edge first. A missing edge → 404 (not 403), matching the
  // three other entity preview endpoints which resolve entity existence
  // before the permission gate (AC-ROUTE-3 / AC-ROUTE-4).
  const { data: edge, error: fetchErr } = await supabase
    .from("edges")
    .select("id, name, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; microgrid_id: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "edge");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!edge) {
    return NextResponse.json(errorBody("Edge not found."), { status: 404 });
  }

  // Permission check after existence is confirmed.
  if (!(await currentUserCanAccessMicrogrid(supabase, edge.microgrid_id))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this edge."),
      { status: 403 }
    );
  }

  const [descendantCounts, parent] = await Promise.all([
    countEntityDescendants(supabase, "edge", id),
    resolveParent(supabase, "edge", id),
  ]);

  return NextResponse.json(
    {
      entity: { id: edge.id, name: edge.name },
      descendant_counts: descendantCounts,
      as_of: new Date().toISOString(),
      parent,
    },
    { status: 200 }
  );
}
