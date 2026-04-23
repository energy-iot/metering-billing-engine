import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { SUPER_ADMIN, ORG_MANAGER } from "@/lib/roles";
import type { UserRole } from "@/lib/types/domain";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/users/[id]/role — change a user's role (UX5 / #79).
 *
 * Delegates to `fn_change_user_role(p_user_id, p_role, p_scope_id)`,
 * invoked via the user-bound server client so the helpers
 * (`is_super_admin()`, `user_can_access_org()`) see the caller's
 * `auth.uid()`. The RPC enforces:
 *   - super_admin-target → caller must be super_admin, scope_id NULL.
 *   - org_manager-target → caller must have access to the target org,
 *     scope_id required.
 * Errors surface as Postgres ERRCODE 42501 / 22023; the BEFORE DELETE
 * trigger also fires during the RPC's internal DELETE → can raise
 * 40000 (last super_admin) or 42501 (self).
 *
 * Error contract: { error: string }
 *   403 — not authorized (42501 or self-revoke)
 *   409 — last super_admin (40000)
 *   422 — invalid parameter (22023)
 *   500 — unexpected
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid user id — expected UUID." },
      { status: 400 }
    );
  }

  let body: { role?: UserRole; scope_id?: string | null };
  try {
    body = (await request.json()) as { role?: UserRole; scope_id?: string | null };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const role = body.role;
  if (role !== SUPER_ADMIN && role !== ORG_MANAGER) {
    return NextResponse.json(
      {
        error: `Role must be one of '${SUPER_ADMIN}' or '${ORG_MANAGER}'.`,
      },
      { status: 422 }
    );
  }

  let scopeId: string | null = null;
  if (role === ORG_MANAGER) {
    scopeId = typeof body.scope_id === "string" ? body.scope_id : "";
    if (!scopeId || !UUID_RE.test(scopeId)) {
      return NextResponse.json(
        {
          error: "org_manager requires a scope_id (org).",
          field: "scope_id",
        },
        { status: 422 }
      );
    }
  }

  const supabase = await createClient();

  const { error } = await supabase.rpc("fn_change_user_role", {
    p_user_id: id,
    p_role: role,
    p_scope_id: scopeId ?? undefined,
  });

  if (error) {
    const pgCode = (error as { code?: string }).code;
    let status = 500;
    if (pgCode === "42501") status = 403;
    else if (pgCode === "22023") status = 422;
    else if (pgCode === "40000") status = 409;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
