import { buildDeletePreviewHandler } from "@/lib/entity-deletion/preview";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";

/**
 * GET /api/edges/[id]/delete-preview — descendant counts for the
 * blast-radius dialog (#89 / AC-ROUTE-3).
 *
 * Permission parity with DELETE: super_admin OR org_manager for the edge's
 * microgrid's parent org (AC-ROUTE-4). We resolve `edge.microgrid_id` and
 * delegate to `currentUserCanAccessMicrogrid`.
 */
export const GET = buildDeletePreviewHandler({
  kind: "edge",
  entityLabel: "edge",
  table: "edges",
  canAccess: async (supabase, id) => {
    const { data: edge } = await supabase
      .from("edges")
      .select("microgrid_id")
      .eq("id", id)
      .maybeSingle<{ microgrid_id: string }>();
    if (!edge) return false;
    return currentUserCanAccessMicrogrid(supabase, edge.microgrid_id);
  },
});
