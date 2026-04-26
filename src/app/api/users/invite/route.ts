import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  currentUserIsSuperAdmin,
  currentUserCanAccessOrg,
} from "@/lib/auth/access";
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";
import { buildInviteDataPayload } from "@/lib/auth/invite-data-payload";
import type { UserRole } from "@/lib/types/domain";

/**
 * POST /api/users/invite — invite a new user (UX5 / #79).
 *
 * Two-client flow (canonical pattern — see src/lib/supabase/service.ts
 * for rationale):
 *
 *   userClient = createClient()         → user-bound, used for:
 *                                           1) defense-in-depth perm checks
 *                                           2) fn_finalize_user_invitation RPC
 *                                              (the RPC is SECURITY DEFINER
 *                                              but still reads auth.uid()
 *                                              from the caller's JWT — so
 *                                              the permission helpers inside
 *                                              the RPC evaluate against the
 *                                              caller, not the function owner)
 *   svc        = createServiceClient()  → service-role, used ONLY for:
 *                                           svc.auth.admin.inviteUserByEmail
 *                                           svc.auth.admin.listUsers
 *                                           svc.auth.admin.deleteUser
 *
 * Steps:
 *   1. Validate body + defense-in-depth permission check.
 *   2. svc.auth.admin.inviteUserByEmail(email) — creates auth.users row
 *      with email_confirmed_at = NULL. Sends the magic-link email.
 *        - On `email_exists` / "already registered" error, fall through
 *          to orphan recovery: if the existing user has no profile +
 *          no role rows, treat them as an orphan from a prior failed
 *          invite and re-use their user_id for step 3.
 *   3. userClient.rpc('fn_finalize_user_invitation', ...) — inserts the
 *      user_profiles + user_roles rows atomically under the caller's
 *      session.
 *   4. Cleanup on RPC failure: svc.auth.admin.deleteUser(userId). Best
 *      effort — log if cleanup also fails.
 *
 * Error contract: { error: string, field?: string }
 *   403 — not authorized (either at the defense-in-depth check or at
 *         the RPC ERRCODE 42501).
 *   409 — existing non-orphan user with the same email.
 *   422 — validation error.
 *   500 — unexpected.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface InviteBody {
  email?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  role?: UserRole;
  scope_id?: string | null;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: InviteBody;
  try {
    body = (await request.json()) as InviteBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validate shape ────────────────────────────────────────────────────
  const email = typeof body.email === "string" ? body.email.trim() : "";
  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json(
      { error: "A valid email is required.", field: "email" },
      { status: 422 }
    );
  }

  const role = body.role;
  if (role !== SUPER_ADMIN && role !== ORG_MANAGER) {
    return NextResponse.json(
      {
        error: `Role must be one of '${SUPER_ADMIN}' or '${ORG_MANAGER}'.`,
        field: "role",
      },
      { status: 422 }
    );
  }

  let scopeId: string | null;
  if (role === SUPER_ADMIN) {
    // super_admin scope MUST be null.
    scopeId = null;
  } else {
    // org_manager scope MUST be a UUID.
    scopeId = typeof body.scope_id === "string" ? body.scope_id : "";
    if (!scopeId || !UUID_RE.test(scopeId)) {
      return NextResponse.json(
        {
          error: "org_manager invitations require a scope_id (org).",
          field: "scope_id",
        },
        { status: 422 }
      );
    }
  }

  const firstName =
    typeof body.first_name === "string" ? body.first_name.trim() : "";
  const lastName =
    typeof body.last_name === "string" ? body.last_name.trim() : "";
  const phone = typeof body.phone === "string" ? body.phone.trim() : "";

  const userClient = await createClient();

  // ── Defense-in-depth permission check ────────────────────────────────
  // RLS + RPC permission checks are the authoritative gates, but we
  // surface a clean 403 before any mutation.
  if (role === SUPER_ADMIN) {
    if (!(await currentUserIsSuperAdmin(userClient))) {
      return NextResponse.json(
        { error: "Only super admins can invite super admins." },
        { status: 403 }
      );
    }
  } else {
    // org_manager invite: caller must have access to the target org.
    if (!scopeId || !(await currentUserCanAccessOrg(userClient, scopeId))) {
      return NextResponse.json(
        {
          error: "You do not have permission to invite into this organization.",
        },
        { status: 403 }
      );
    }
  }

  // ── Step 2: invite via GoTrue admin API ──────────────────────────────
  //
  // The `data` payload (UX5b / #184) is forwarded to the email template
  // so the rendered invitation includes the inviter name, org name, and
  // a humanized role label. GoTrue persists this on
  // auth.users.raw_user_meta_data — see invite-data-payload.ts.
  const {
    data: { user: caller },
  } = await userClient.auth.getUser();
  if (!caller) {
    // Should not happen — RLS in the perm checks above already requires
    // an authenticated session — but guard for type-narrowing.
    return NextResponse.json(
      { error: "Authentication required." },
      { status: 401 }
    );
  }

  const inviteData = await buildInviteDataPayload({
    caller,
    targetRole: role,
    targetOrgId: scopeId,
    supabase: userClient,
  });

  const svc = createServiceClient();

  const inviteRes = await svc.auth.admin.inviteUserByEmail(email, {
    data: inviteData,
  });
  let targetUserId: string | null = null;

  if (inviteRes.error) {
    // Defensive email_exists detection across SDK versions — check
    // error.code AND a message-text fallback.
    const errCode = (inviteRes.error as { code?: string }).code;
    const msg = inviteRes.error.message?.toLowerCase() ?? "";
    const isEmailExists =
      errCode === "email_exists" ||
      msg.includes("already registered") ||
      msg.includes("already been registered") ||
      msg.includes("user already exists") ||
      msg.includes("already in use");

    if (!isEmailExists) {
      return NextResponse.json(
        { error: `Invite failed: ${inviteRes.error.message}` },
        { status: 422 }
      );
    }

    // Orphan-recovery path: look up the existing auth.users row by email.
    // MVP uses a single page; pagination is deferred (see ticket
    // Out-of-Scope).
    const existing = await findAuthUserByEmail(svc, email);
    if (!existing) {
      // GoTrue said "email exists" but we couldn't find them. Surface
      // the original error — something is off.
      return NextResponse.json(
        {
          error: "User already exists in MBE",
          field: "email",
        },
        { status: 409 }
      );
    }

    // Does the existing user have any profile / role rows? If yes, they
    // are a real MBE user — don't re-invite. If no, treat as an orphan
    // left over from a prior failed invite.
    const hasProfile = await userHasProfile(svc, existing.id);
    const hasRole = await userHasAnyRole(svc, existing.id);
    if (hasProfile || hasRole) {
      return NextResponse.json(
        { error: "User already exists in MBE", field: "email" },
        { status: 409 }
      );
    }

    // Orphan. Proceed against the existing user_id.
    targetUserId = existing.id;
  } else {
    targetUserId = inviteRes.data.user?.id ?? null;
    if (!targetUserId) {
      return NextResponse.json(
        { error: "Invite succeeded but no user ID was returned." },
        { status: 500 }
      );
    }
  }

  // ── Step 3: finalize via user-bound RPC (permission-checked inside) ──
  const { error: rpcError } = await userClient.rpc(
    "fn_finalize_user_invitation",
    {
      p_user_id: targetUserId,
      p_first_name: firstName || null,
      p_last_name: lastName || null,
      p_phone: phone || null,
      p_role: role,
      p_scope_id: scopeId ?? undefined,
    }
  );

  if (rpcError) {
    // Step 4: cleanup the auth.users row so the caller can retry.
    // Best-effort: log but don't mask the original error.
    try {
      await svc.auth.admin.deleteUser(targetUserId);
    } catch (cleanupErr) {
      console.error(
        "[invite] Failed to clean up auth.users after RPC failure:",
        cleanupErr
      );
    }

    // Map Postgres errcode to HTTP.
    //   42501 → 403 (permission denied by RPC's SECURITY INVOKER check)
    //   22023 → 422 (invalid parameter — e.g. scope_id missing)
    const pgCode = (rpcError as { code?: string }).code;
    const status = pgCode === "42501" ? 403 : pgCode === "22023" ? 422 : 500;
    return NextResponse.json(
      { error: `Invite failed: ${rpcError.message}` },
      { status }
    );
  }

  return NextResponse.json({ user_id: targetUserId }, { status: 201 });
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function findAuthUserByEmail(
  svc: SupabaseClient,
  email: string
): Promise<User | null> {
  const lower = email.toLowerCase();
  // MVP uses a single page; pagination is deferred. 1000 is far above
  // any plausible MBE user count at pilot scale.
  const { data, error } = await svc.auth.admin.listUsers({ perPage: 1000 });
  if (error || !data) return null;
  if (data.users.length === 1000) {
    console.warn(
      "[invite] listUsers returned exactly 1000 users — cap reached. " +
        "Some users may be invisible to orphan-recovery lookup. " +
        "Implement pagination when user count approaches 1000."
    );
  }
  return data.users.find((u) => u.email?.toLowerCase() === lower) ?? null;
}

async function userHasProfile(
  svc: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { count } = await svc
    .from("user_profiles")
    .select("user_id", { head: true, count: "exact" })
    .eq("user_id", userId);
  return (count ?? 0) > 0;
}

async function userHasAnyRole(
  svc: SupabaseClient,
  userId: string
): Promise<boolean> {
  const { count } = await svc
    .from("user_roles")
    .select("id", { head: true, count: "exact" })
    .eq("user_id", userId);
  return (count ?? 0) > 0;
}
