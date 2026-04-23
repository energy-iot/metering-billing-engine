import "server-only";

/**
 * access.ts — server-only access helpers.
 *
 * Created in #76 (UX4a entity CRUD). Separate from `src/lib/roles.ts` — that
 * file is client-safe role CONSTANTS; this file is SERVER-ONLY role CHECKS that
 * hit Supabase. The `import 'server-only'` directive at the top causes any
 * accidental import from a client bundle to fail at build time.
 *
 * All helpers accept a Supabase server client (created by
 * `@/lib/supabase/server`) so the caller's session (cookies) is honored. RLS
 * remains the authoritative gate — these helpers are defense-in-depth for
 * producing actionable 403s before a Postgres 42501 surfaces from the DB.
 *
 * Rationale for caching the user_roles fetch per call:
 *   - Each request handler typically checks a single entity; we query
 *     user_roles exactly once via `getCurrentUserRoles` and derive the other
 *     helpers from that row set.
 *   - We resolve parent IDs (community → org, microgrid → community → org)
 *     via targeted queries — cheaper than round-tripping through RPC.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserRoleRecord } from "@/lib/types/domain";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG } from "@/lib/roles";

/**
 * Returns all user_roles rows for the currently authenticated user.
 * Empty array if unauthenticated or the user has no role rows yet.
 */
export async function getCurrentUserRoles(
  supabase: SupabaseClient
): Promise<UserRoleRecord[]> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from("user_roles")
    .select("*")
    .eq("user_id", user.id)
    .returns<UserRoleRecord[]>();

  if (error) return [];
  return data ?? [];
}

/**
 * True iff the current user has any role row with role = 'super_admin'.
 */
export async function currentUserIsSuperAdmin(
  supabase: SupabaseClient
): Promise<boolean> {
  const roles = await getCurrentUserRoles(supabase);
  return roles.some((r) => r.role === SUPER_ADMIN);
}

/**
 * True iff the current user is a super_admin OR holds an org_manager row
 * scoped to the given org.
 */
export async function currentUserCanAccessOrg(
  supabase: SupabaseClient,
  orgId: string
): Promise<boolean> {
  const roles = await getCurrentUserRoles(supabase);
  if (roles.some((r) => r.role === SUPER_ADMIN)) return true;
  return roles.some(
    (r) =>
      r.role === ORG_MANAGER &&
      r.scope_type === SCOPE_ORG &&
      r.scope_id === orgId
  );
}

/**
 * True iff the current user can access the org that the given community
 * belongs to. Returns false if the community is not found (or RLS hides it).
 */
export async function currentUserCanAccessCommunity(
  supabase: SupabaseClient,
  communityId: string
): Promise<boolean> {
  // Short-circuit: super_admins can always access.
  if (await currentUserIsSuperAdmin(supabase)) return true;

  const { data, error } = await supabase
    .from("communities")
    .select("org_id")
    .eq("id", communityId)
    .maybeSingle<{ org_id: string }>();

  if (error || !data) return false;
  return currentUserCanAccessOrg(supabase, data.org_id);
}

/**
 * True iff the current user can access the org for the given microgrid
 * (microgrid → community → org chain). Returns false if not found.
 */
export async function currentUserCanAccessMicrogrid(
  supabase: SupabaseClient,
  microgridId: string
): Promise<boolean> {
  // Short-circuit: super_admins can always access.
  if (await currentUserIsSuperAdmin(supabase)) return true;

  const { data: mg, error: mgErr } = await supabase
    .from("microgrids")
    .select("community_id")
    .eq("id", microgridId)
    .maybeSingle<{ community_id: string }>();

  if (mgErr || !mg) return false;
  return currentUserCanAccessCommunity(supabase, mg.community_id);
}
