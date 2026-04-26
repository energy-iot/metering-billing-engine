import "server-only";

/**
 * invite-data-payload.ts — shared helper to build the `data` payload
 * passed to `auth.admin.inviteUserByEmail` (UX5b / #184).
 *
 * The Supabase email template renders rich content (inviter name, org
 * name, role label, app name) by reading `{{ .Data.field }}` template
 * variables. GoTrue forwards anything we put in `data` through to the
 * template AND persists it on `auth.users.raw_user_meta_data`
 * (`user_metadata` alias) — see GoTrueAdminApi.ts:141-165.
 *
 * Architectural decisions (see ticket #184 Dev Notes):
 *
 *   - `null`/empty `org_name` and `invited_by_name` are OMITTED from
 *     the returned object (NOT sent as JSON null) so the template's
 *     `{{ if .Data.field }}` branches resolve correctly. Go's
 *     text/template treats null as "set" — only absence falls through
 *     to the else branch.
 *
 *   - `org_name` is omitted entirely for super_admin invites (no org
 *     scope by definition).
 *
 *   - Caller name resolution: trimmed `first_name + ' ' + last_name`
 *     from `user_profiles`; fallback to caller email when both names
 *     are NULL/empty.
 *
 *   - Org name resolution uses the user-bound supabase client (RLS
 *     gates visibility — defense-in-depth: if the caller cannot see
 *     the org, the route's permission check would have already 403'd).
 *
 *   - `app_name` is hardcoded `'Metering & Billing Engine'`. The
 *     payload field exists for forward-compat (per-tenant template
 *     branding); no override UI in MVP.
 *
 * Used by:
 *   - POST /api/users/invite
 *   - POST /api/users/[id]/resend-invite
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";
import type { UserRole } from "@/lib/types/domain";

const APP_NAME = "Metering & Billing Engine";

export interface InviteDataPayload {
  invited_by_name?: string;
  org_name?: string;
  role_label: string;
  app_name: string;
}

export interface BuildInviteDataPayloadParams {
  /** The authenticated caller (must have a non-null email). */
  caller: User;
  /** The role being assigned (or current role on resend). */
  targetRole: UserRole;
  /** The org id when targetRole === 'org_manager'; null/omit for super_admin. */
  targetOrgId?: string | null;
  /** User-bound supabase client (RLS-honoring, for caller name + org name lookups). */
  supabase: SupabaseClient;
}

/**
 * Build the `data` payload for `auth.admin.inviteUserByEmail`.
 *
 * Returns an object with only the populated keys — null/empty values
 * are OMITTED (not sent as JSON null) so Go template `{{ if .Data.x }}`
 * branches resolve correctly.
 */
export async function buildInviteDataPayload(
  params: BuildInviteDataPayloadParams
): Promise<InviteDataPayload> {
  const { caller, targetRole, targetOrgId, supabase } = params;

  // ── Caller name (single round trip). ──
  const invitedByName = await resolveCallerName(supabase, caller);

  // ── Org name (org_manager target only). ──
  let orgName: string | null = null;
  if (targetRole === ORG_MANAGER && targetOrgId) {
    orgName = await resolveOrgName(supabase, targetOrgId);
  }

  // ── Role label (humanized). ──
  const roleLabel = humanizeRoleLabel(targetRole);

  // Build payload — omit null/empty fields entirely.
  const payload: InviteDataPayload = {
    role_label: roleLabel,
    app_name: APP_NAME,
  };
  if (invitedByName) payload.invited_by_name = invitedByName;
  if (orgName) payload.org_name = orgName;
  return payload;
}

// ── Internals ─────────────────────────────────────────────────────────

async function resolveCallerName(
  supabase: SupabaseClient,
  caller: User
): Promise<string> {
  const { data } = await supabase
    .from("user_profiles")
    .select("first_name, last_name")
    .eq("user_id", caller.id)
    .maybeSingle<{ first_name: string | null; last_name: string | null }>();

  const first = (data?.first_name ?? "").trim();
  const last = (data?.last_name ?? "").trim();
  const composed = `${first} ${last}`.trim();
  if (composed) return composed;
  // Fallback to email — auth.User.email is non-null in practice for
  // invite/resend callers (they're authenticated session users), but
  // the type allows undefined so guard.
  return caller.email ?? "";
}

async function resolveOrgName(
  supabase: SupabaseClient,
  orgId: string
): Promise<string | null> {
  const { data, error } = await supabase
    .from("organizations")
    .select("name")
    .eq("id", orgId)
    .maybeSingle<{ name: string }>();

  if (error || !data) return null;
  const trimmed = data.name?.trim();
  return trimmed || null;
}

function humanizeRoleLabel(role: UserRole): string {
  if (role === SUPER_ADMIN) return "a super administrator";
  if (role === ORG_MANAGER) return "an organization manager";
  // Future-proof: any unknown role enum value falls back to its raw token.
  return role;
}
