import { buildDeletePreviewHandler } from "@/lib/entity-deletion/preview";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";

/**
 * GET /api/microgrids/[id]/delete-preview — descendant counts for the
 * blast-radius dialog (#89 / AC-ROUTE-3).
 *
 * Permission parity with DELETE: super_admin OR org_manager for the
 * microgrid's parent org (AC-ROUTE-4).
 */
export const GET = buildDeletePreviewHandler({
  kind: "microgrid",
  entityLabel: "microgrid",
  table: "microgrids",
  canAccess: (supabase, id) => currentUserCanAccessMicrogrid(supabase, id),
});
