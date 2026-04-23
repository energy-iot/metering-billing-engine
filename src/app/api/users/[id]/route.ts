import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/users/[id] — soft-delete a user (UX5 / #79).
 *
 * IMPORTANT: uses the user-bound server client, NOT the service-role
 * client. Rationale:
 *
 *   - The BEFORE DELETE trigger on `user_roles`
 *     (fn_user_roles_before_delete_guard) checks `auth.uid()` for the
 *     self-revocation guard, and the last-super_admin guard relies on
 *     RLS-filtered counts. The service-role client has `auth.uid()`
 *     = NULL and bypasses RLS — both guards would misbehave (the
 *     self-revoke guard would be skipped, and the last-super_admin
 *     count would read ALL rows regardless of caller).
 *
 *   - Additionally, user_roles RLS enforces "super_admin may manage
 *     all" — org_managers cannot `DELETE FROM user_roles WHERE ...`
 *     unless the existing policy changes. The route's user-bound
 *     DELETE naturally produces zero rows affected for an org_manager
 *     targeting rows they don't own; we convert that to 403.
 *
 * Soft-delete semantics: removes all `user_roles` rows for the target
 * user. Does NOT touch `auth.users` or `user_profiles` — this preserves
 * the audit trail and allows re-invitation later.
 *
 * Errors:
 *   204 — success (no body).
 *   400 — invalid id.
 *   403 — not authorized (self-revoke trigger / RLS filtered).
 *   409 — last super_admin (trigger 40000).
 *   500 — unexpected.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid user id — expected UUID." },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  const { error, count } = await supabase
    .from("user_roles")
    .delete({ count: "exact" })
    .eq("user_id", id);

  if (error) {
    // Trigger RAISEs surface here with a pg code.
    const pgCode = (error as { code?: string }).code;
    let status = 500;
    if (pgCode === "42501") status = 403;
    else if (pgCode === "40000") status = 409;
    return NextResponse.json({ error: error.message }, { status });
  }

  if ((count ?? 0) === 0) {
    // Either the user didn't have any role rows to begin with, or RLS
    // filtered them out. Either way the caller cannot revoke — 403.
    return NextResponse.json(
      { error: "No roles revoked (not authorized, or user has no roles)." },
      { status: 403 }
    );
  }

  return new NextResponse(null, { status: 204 });
}
