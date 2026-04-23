import { createClient } from "@/lib/supabase/server";
import {
  getCurrentUserRoles,
  currentUserIsSuperAdmin,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";
import type { UserDirectoryRow, UserRoleRecord } from "@/lib/types/domain";
import { UsersPageClient } from "./users-page-client";

/**
 * /settings/users — admin view of all users visible to the caller.
 *
 * Server component: reads the user_directory VIEW (security_invoker;
 * RLS on user_profiles filters rows via user_can_see_user_profile).
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

  // Fetch rows.
  const { data: rowsData } = await supabase
    .from("user_directory")
    .select("*");
  const rows: UserDirectoryRow[] = (rowsData ?? []).filter(
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
