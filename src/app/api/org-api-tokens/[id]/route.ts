import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * DELETE /api/org-api-tokens/:id — revoke an existing token (#256).
 *
 * Hard cutover: sets `revoked_at = now()`. Any caller using this token
 * gets a 401 on its next request (the auth flow's `WHERE revoked_at IS
 * NULL` filter excludes the row).
 *
 * Authorization: super_admin OR org_manager scoped to the token's org_id.
 * The DB UPDATE policy (00043) enforces the same check; the explicit
 * pre-flight gives a clean 403 instead of a Postgres 42501.
 *
 * Idempotency: revoking an already-revoked token returns 200 with
 * `{ alreadyRevoked: true }` — no audit row written for the second call,
 * mirroring the "no-op" convention for re-applying state.
 *
 * Audit: writes `event_type='token_revoked'` with the actor's auth.uid().
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid token id — expected UUID.", field: "id" },
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // ── Resolve the row first (RLS-scoped read) ─────────────────────────────
  // We read name + org_id to (a) confirm caller can see it, (b) populate
  // the audit row's `details`, and (c) detect the already-revoked case
  // before issuing the UPDATE. If the row doesn't exist (or RLS hides it),
  // we 404 — UUID-enumeration defense, mirrors the 2026-04 permission-
  // before-target-lookup learning.
  const { data: row, error: readErr } = await supabase
    .from("org_api_tokens")
    .select("id, org_id, name, revoked_at")
    .eq("id", id)
    .maybeSingle();

  if (readErr) {
    return NextResponse.json(
      { error: `Failed to look up token: ${readErr.message}` },
      { status: 500 }
    );
  }
  if (!row) {
    return NextResponse.json({ error: "Token not found." }, { status: 404 });
  }

  // Defense-in-depth (route-level) — RLS UPDATE is the authoritative gate.
  if (!(await currentUserCanAccessOrg(supabase, row.org_id))) {
    return NextResponse.json(
      { error: "Not authorized to manage tokens for this organization." },
      { status: 403 }
    );
  }

  if (row.revoked_at !== null) {
    // Idempotent — already revoked. Don't double-audit.
    return NextResponse.json(
      { id: row.id, alreadyRevoked: true },
      { status: 200 }
    );
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json(
      { error: "Not authenticated." },
      { status: 401 }
    );
  }

  const { error: updErr } = await supabase
    .from("org_api_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .is("revoked_at", null); // race-safe — second concurrent caller is a no-op.

  if (updErr) {
    if (updErr.code === "42501" || updErr.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to manage tokens for this organization." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to revoke token: ${updErr.message}` },
      { status: 500 }
    );
  }

  const { error: auditErr } = await supabase
    .from("billing_audit_log")
    .insert({
      org_id: row.org_id,
      billing_period_id: null,
      event_type: "token_revoked",
      actor_user_id: user.id,
      actor_kind: "human",
      actor_ref: null,
      details: { org_api_token_id: row.id, name: row.name },
    });

  if (auditErr) {
    console.warn(
      JSON.stringify({
        event: "org_api_tokens.revoke.audit_write_failed",
        org_api_token_id: row.id,
        org_id: row.org_id,
        pg_code: auditErr.code,
        pg_message: auditErr.message,
        at: new Date().toISOString(),
      })
    );
  }

  revalidatePath("/settings/api-tokens");

  return NextResponse.json({ id: row.id }, { status: 200 });
}
