import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER, SCOPE_ORG } from "@/lib/roles";
import { buildInviteDataPayload } from "@/lib/auth/invite-data-payload";
import { resolveOrigin } from "@/lib/auth/resolve-origin";
import type { UserRole, RoleScopeType } from "@/lib/types/domain";

/**
 * POST /api/users/[id]/resend-invite — re-issue an invitation email
 * for an existing-but-unconfirmed user (UX5b / #184).
 *
 * Two-client pattern (mirrors POST /api/users/invite):
 *   userClient = createClient()         → permission checks (RLS-honoring).
 *   svc        = createServiceClient()  → svc.auth.admin.* ops only.
 *
 * Security ordering — permission BEFORE target lookup. Probing UUIDs
 * via this endpoint must produce uniform 403 for invisible rows so
 * an attacker cannot distinguish "exists but you can't resend" from
 * "doesn't exist":
 *
 *   Step A — caller authentication.
 *           userClient.auth.getUser() → 401 if no session.
 *
 *   Step B — resolve target's CURRENT role row via the user_directory
 *           VIEW (user-bound client). The view's WHERE clause calls
 *           `user_can_see_user_profile(user_id)` so RLS-equivalent
 *           visibility is enforced uniformly: invisible row → uniform
 *           403, never "not found". Reading directly from `user_roles`
 *           would NOT work for org_manager → org_manager-in-same-org
 *           because no `user_roles` SELECT policy grants cross-user
 *           reads (only "own row" + super_admin FOR ALL).
 *
 *           Orphans surface as a row whose `role` column is NULL (LEFT
 *           JOIN miss). The visibility helper still gates them: an
 *           orphan is only visible to the orphan-target itself OR a
 *           super_admin. Caller-side we still require super_admin to
 *           proceed on a NULL-role row.
 *
 *   Step C — caller permission against TARGET's role row.
 *           super_admin target → caller must be super_admin.
 *           org_manager target → caller must pass currentUserCanAccessOrg.
 *
 *   Step D — target user lookup via svc.auth.admin.getUserById.
 *           Both error.code === 'user_not_found' AND !data.user → 404.
 *
 *   Step E — pre-check email_confirmed_at IS NOT NULL → 409
 *           "User has already accepted their invitation."
 *
 *   Step F — build the data payload (shared helper) reflecting the
 *           target's CURRENT role/scope (architect decision: invite
 *           reflects current state, not the original).
 *
 *   Step G — svc.auth.admin.inviteUserByEmail(email, { data }).
 *           - 'over_email_send_rate_limit' (or message-text fallback) → 429.
 *           - 'email_exists' (race: user confirmed between pre-check and
 *             GoTrue call) → 409 with the same shape as the pre-check.
 *           - any other error → 422.
 *
 * Returns 200 { resent: true } on success. Idempotent at the API
 * layer; GoTrue rate-limits internally.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CurrentRoleRow {
  role: UserRole | null;
  scope_type: RoleScopeType | null;
  scope_id: string | null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: targetId } = await params;

  if (!UUID_RE.test(targetId)) {
    return NextResponse.json(
      { error: "Invalid user id — expected UUID." },
      { status: 400 }
    );
  }

  const userClient = await createClient();

  // ── Step A: authenticate caller ────────────────────────────────────
  const {
    data: { user: caller },
  } = await userClient.auth.getUser();
  if (!caller) {
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    );
  }

  // ── Step B: resolve target's CURRENT role row via user_directory ───
  //
  // user_directory is a VIEW (00014_user_directory_view.sql) that
  // joins auth.users LEFT user_profiles LEFT user_roles, gated by
  // `WHERE user_can_see_user_profile(au.id)`. The helper is
  // SECURITY DEFINER and reads `auth.uid()` from the caller's JWT —
  // it returns true iff the caller is the target, is a super_admin,
  // OR shares an org-scoped manager role with the target. So a row
  // returned here is guaranteed visible to the caller; a NULL row
  // means "doesn't exist OR you can't see it" — uniform 403 (the
  // enumeration-defense rule the route docstring describes).
  //
  // We deliberately do NOT read `user_roles` directly: that table's
  // SELECT policies only grant "own row" + super_admin FOR ALL, so
  // an org_manager B trying to resend an org_manager C in the SAME
  // org would get a NULL row and be 403'd — even though both the
  // RLS helper and the rest of the app correctly consider C visible
  // to B. The view is the single source of truth for "can A see B".
  const { data: targetRoleRow } = await userClient
    .from("user_directory")
    .select("role, scope_type, scope_id")
    .eq("user_id", targetId)
    .maybeSingle<CurrentRoleRow>();

  // ── Step C: caller permission against TARGET's role ────────────────
  const callerIsSuper = await currentUserIsSuperAdmin(userClient);

  if (!targetRoleRow) {
    // Either the target doesn't exist OR is invisible to this caller.
    // Uniform 403 (existence-leak hardening). Super_admin sees all
    // rows via the view, so a NULL here for super_admin truly means
    // "doesn't exist" — but we still 403 here to keep one branch;
    // the canonical 404 surfaces at Step D via getUserById.
    if (!callerIsSuper) {
      return NextResponse.json(
        { error: "You do not have permission to resend this invitation." },
        { status: 403 }
      );
    }
    // super_admin proceeds; getUserById will produce the canonical 404
    // if the auth user is genuinely absent.
  } else if (targetRoleRow.role == null) {
    // Visible row with NULL role = orphan (LEFT JOIN miss on user_roles).
    // Only a super_admin can recover an orphan — everyone else 403.
    if (!callerIsSuper) {
      return NextResponse.json(
        { error: "You do not have permission to resend this invitation." },
        { status: 403 }
      );
    }
  } else if (targetRoleRow.role === SUPER_ADMIN) {
    if (!callerIsSuper) {
      return NextResponse.json(
        { error: "You do not have permission to resend this invitation." },
        { status: 403 }
      );
    }
  } else if (targetRoleRow.role === ORG_MANAGER) {
    if (
      targetRoleRow.scope_type !== SCOPE_ORG ||
      !targetRoleRow.scope_id ||
      !(await currentUserCanAccessOrg(userClient, targetRoleRow.scope_id))
    ) {
      return NextResponse.json(
        { error: "You do not have permission to resend this invitation." },
        { status: 403 }
      );
    }
  } else {
    // Unknown role enum value (future-proofing). Reject conservatively.
    return NextResponse.json(
      { error: "You do not have permission to resend this invitation." },
      { status: 403 }
    );
  }

  // ── Step D: target user lookup (after permission has passed) ───────
  const svc = createServiceClient();
  const lookup = await svc.auth.admin.getUserById(targetId);
  const lookupErrCode = (lookup.error as { code?: string } | null)?.code;
  if (lookupErrCode === "user_not_found" || !lookup.data?.user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }
  const targetUser = lookup.data.user;
  const targetEmail = targetUser.email;
  if (!targetEmail) {
    // Defensive — auth.users rows always have email for invite-flow
    // users, but the SDK type permits undefined.
    return NextResponse.json(
      { error: "Target user has no email on record." },
      { status: 422 }
    );
  }

  // ── Step E: pre-check already-confirmed ────────────────────────────
  if (targetUser.email_confirmed_at != null) {
    return NextResponse.json(
      { error: "User has already accepted their invitation." },
      { status: 409 }
    );
  }

  // ── Step F: build data payload reflecting CURRENT role/scope ──────
  //
  // For orphans (no role row), we still pass app_name + a generic role
  // label so the template renders consistently. invited_by_name and
  // org_name are populated when applicable.
  const data = await buildInviteDataPayload({
    caller,
    targetRole: targetRoleRow?.role ?? ORG_MANAGER, // orphan fallback
    targetOrgId: targetRoleRow?.scope_id ?? null,
    supabase: userClient,
  });

  // ── Step G: re-issue the invite ────────────────────────────────────
  // Per-call redirectTo so resends land on the MBE accept-invite page
  // (UX5c / #189) — same target as the original invite.
  const origin = resolveOrigin(request);
  const inviteRes = await svc.auth.admin.inviteUserByEmail(targetEmail, {
    data,
    redirectTo: `${origin}/accept-invite`,
  });

  if (inviteRes.error) {
    const errCode = (inviteRes.error as { code?: string }).code;
    const msg = inviteRes.error.message?.toLowerCase() ?? "";

    // Rate-limit detection: code first, then message-text fallback for
    // older GoTrue/SDK versions that don't set `code`.
    const isRateLimited =
      errCode === "over_email_send_rate_limit" ||
      msg.includes("over_email_send_rate_limit") ||
      msg.includes("rate limit") ||
      msg.includes("too many requests");
    if (isRateLimited) {
      return NextResponse.json(
        {
          error:
            "Too many invitations sent recently. Try again in a few minutes.",
          code: "rate_limited",
        },
        { status: 429 }
      );
    }

    // Race: target was confirmed between our pre-check and GoTrue's
    // call. Surface the same shape as the pre-check.
    if (errCode === "email_exists") {
      return NextResponse.json(
        { error: "User has already accepted their invitation." },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: `Resend failed: ${inviteRes.error.message}` },
      { status: 422 }
    );
  }

  return NextResponse.json({ resent: true }, { status: 200 });
}
