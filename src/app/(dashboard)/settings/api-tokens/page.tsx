import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getCurrentUserRoles,
  currentUserIsSuperAdmin,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG } from "@/lib/roles";
import type { OrgApiToken, UserRoleRecord } from "@/lib/types/domain";
import { ApiTokensPageClient } from "./_components/api-tokens-page-client";

type RawToken = Pick<
  OrgApiToken,
  | "id"
  | "org_id"
  | "name"
  | "env_prefix"
  | "token_lookup"
  | "created_at"
  | "created_by"
  | "last_used_at"
  | "revoked_at"
>;

/**
 * /settings/api-tokens — org-admin UI for per-org API token management
 * (#256). Server component:
 *
 *   • super_admin → all orgs in scope.
 *   • org_manager → only their scoped orgs.
 *   • all other authenticated users → redirect to /settings/profile
 *     (the page is gated; we redirect rather than 404 so the URL still
 *     resolves to a real surface).
 *   • unauthenticated callers are caught by middleware before this loads.
 *
 * Lists ONLY non-revoked tokens (the UI surface for active credentials —
 * the per-row "Revoke" action sets revoked_at and the row disappears on
 * next load). Future "revoked tokens audit" panel can `.is('revoked_at',
 * null).not('revoked_at', null)` flip if/when needed.
 */
export default async function SettingsApiTokensPage() {
  const supabase = await createClient();

  const isSuperAdmin = await currentUserIsSuperAdmin(supabase);
  const roles: UserRoleRecord[] = await getCurrentUserRoles(supabase);

  // Scope: super_admin sees all; org_manager sees only their org_ids.
  const callerOrgIds: string[] = Array.from(
    new Set(
      roles
        .filter(
          (r) =>
            r.role === ORG_MANAGER &&
            r.scope_type === SCOPE_ORG &&
            r.scope_id != null
        )
        .map((r) => r.scope_id as string)
    )
  );

  if (!isSuperAdmin && callerOrgIds.length === 0) {
    // Neither role applies — punt to profile (the always-accessible tab).
    redirect("/settings/profile");
  }

  // Fetch orgs the caller can see (RLS-filtered). Used to populate the
  // org-picker in the Generate dialog.
  const { data: orgsData } = await supabase
    .from("organizations")
    .select("id, name")
    .order("name", { ascending: true });
  const orgs = (orgsData ?? []).map((o) => ({ id: o.id, name: o.name }));

  // Fetch active tokens. RLS is the authoritative scope; super_admin sees
  // every org's tokens, org_manager sees only their org's.
  const { data: tokensData } = await supabase
    .from("org_api_tokens")
    .select(
      "id, org_id, name, env_prefix, token_lookup, created_at, created_by, last_used_at, revoked_at"
    )
    .is("revoked_at", null)
    .order("created_at", { ascending: false });

  const tokens: RawToken[] = (tokensData ?? []) as RawToken[];

  // Resolve created_by display names via fn_list_visible_users (RPC).
  // #269 replaced the user_directory view with this RPC; visibility
  // semantics are preserved (RLS-hidden actors → no row → fallback).
  const creatorIds = Array.from(
    new Set(tokens.map((t) => t.created_by).filter((id): id is string => !!id))
  );
  const creatorNames: Record<string, string> = {};
  if (creatorIds.length > 0) {
    const { data: dirRows } = await supabase.rpc("fn_list_visible_users", {
      _target_user_ids: creatorIds,
    });
    for (const r of dirRows ?? []) {
      if (!r.user_id) continue;
      const first = (r.first_name ?? "").trim();
      const last = (r.last_name ?? "").trim();
      const fullName = [first, last].filter(Boolean).join(" ");
      creatorNames[r.user_id] = fullName || (r.email ?? "Unknown user");
    }
  }

  // Build org-name lookup for "Org" column (super_admin sees multiple orgs).
  const orgNames: Record<string, string> = {};
  for (const o of orgs) orgNames[o.id] = o.name;

  const callerRole: "super_admin" | "org_manager" = isSuperAdmin
    ? SUPER_ADMIN
    : ORG_MANAGER;

  return (
    <ApiTokensPageClient
      tokens={tokens}
      orgs={orgs}
      orgNames={orgNames}
      creatorNames={creatorNames}
      callerRole={callerRole}
    />
  );
}
