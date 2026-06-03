import { createClient } from "@/lib/supabase/server";
import {
  getCurrentUserRoles,
  currentUserIsSuperAdmin,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";
import type { UserVisibleRow, UserRoleRecord } from "@/lib/types/domain";
import { UsersPageClient } from "./users-page-client";

/**
 * /settings/users — admin view of all users visible to the caller.
 *
 * Server component: calls the `fn_list_visible_users` RPC (migration
 * 00046) which enforces the `user_can_see_user_profile(user_id)`
 * visibility predicate body-side. The RPC supersedes the old
 * `user_directory` view (dropped in #269 to clear two CRITICAL
 * Supabase linter ERRORs: auth_users_exposed + security_definer_view).
 *
 * Also fetches the org list (for the Invite dialog) scoped to the
 * caller's role:
 *   - super_admin → all orgs (limited by organizations RLS, which
 *     grants super_admin full access).
 *   - org_manager → only the orgs the caller can access.
 *
 * Status is derived from email_confirmed_at: NULL = "Invited", else
 * "Active". DO NOT use last_sign_in_at — it is NULL for any logged-out
 * confirmed user.
 */
export default async function SettingsUsersPage() {
  const supabase = await createClient();

  const isSuperAdmin = await currentUserIsSuperAdmin(supabase);
  const roles: UserRoleRecord[] = await getCurrentUserRoles(supabase);

  // Caller's org scopes (for the Invite dialog and revoke gating).
  const callerOrgIds: string[] = Array.from(
    new Set(
      roles
        .filter((r) => r.role === ORG_MANAGER && r.scope_id != null)
        .map((r) => r.scope_id as string)
    )
  );

  // Fetch rows. No args → list all visible users (per the RPC contract).
  const { data: rowsData } = await supabase.rpc("fn_list_visible_users");
  const rows: UserVisibleRow[] = ((rowsData ?? []) as UserVisibleRow[]).filter(
    (r) => r.user_id != null
  );

  // Fetch orgs for the invite/edit dialogs.
  // RLS on organizations filters this appropriately for the caller.
  const { data: orgsData } = await supabase
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true });
  const orgs = (orgsData ?? []).map((o) => ({ id: o.id, name: o.name }));

  // Current user id (for "own row" / revoke-self guards on the client).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const currentUserId = user?.id ?? "";
  const callerRole: "super_admin" | "org_manager" = isSuperAdmin
    ? SUPER_ADMIN
    : ORG_MANAGER;

  return (
    <UsersPageClient
      rows={rows}
      orgs={orgs}
      callerRole={callerRole}
      callerOrgIds={callerOrgIds}
      currentUserId={currentUserId}
    />
  );
}
