import { buildDeletePreviewHandler } from "@/lib/entity-deletion/preview";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";

/**
 * GET /api/organizations/[id]/delete-preview — descendant counts for the
 * blast-radius dialog (#89 / AC-ROUTE-3).
 *
 * Permission parity with DELETE: super_admin only (AC-ROUTE-4).
 */
export const GET = buildDeletePreviewHandler({
  kind: "organization",
  entityLabel: "organization",
  table: "organizations",
  canAccess: async (supabase) => currentUserIsSuperAdmin(supabase),
});
