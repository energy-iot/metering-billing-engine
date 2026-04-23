import { buildDeletePreviewHandler } from "@/lib/entity-deletion/preview";
import { currentUserCanAccessCommunity } from "@/lib/auth/access";

/**
 * GET /api/communities/[id]/delete-preview — descendant counts for the
 * blast-radius dialog (#89 / AC-ROUTE-3).
 *
 * Permission parity with DELETE: super_admin OR org_manager for the
 * community's parent org (AC-ROUTE-4).
 */
export const GET = buildDeletePreviewHandler({
  kind: "community",
  entityLabel: "community",
  table: "communities",
  canAccess: (supabase, id) => currentUserCanAccessCommunity(supabase, id),
});
