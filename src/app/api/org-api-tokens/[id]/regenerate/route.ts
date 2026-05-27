import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { generateToken } from "@/lib/internal-auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/org-api-tokens/:id/regenerate — revoke old + create new with
 * the same `name` and `org_id`. Returns the new token's `{ id, plaintext }`
 * — plaintext shown ONCE in the UI's TokenRevealModal.
 *
 * Hard cutover semantics — see #256 Regenerate dialog copy:
 *   "Old token will be revoked immediately. Any customerapp instance still
 *    using the old token will get 401 errors until you update its
 *    configuration."
 *
 * NOT a DB transaction: two separate writes (UPDATE old + INSERT new).
 * Concrete failure modes:
 *   • UPDATE succeeds, INSERT fails — operator has no working token. The
 *     UI presents the error; recovery is "Generate" with the old name.
 *   • UPDATE fails before INSERT — old token still works; operator sees
 *     error and can retry.
 * Wrapping in an RPC would tighten this but the failure window is small
 * and the recovery is bounded; defer until customer-reported.
 *
 * Authorization: super_admin OR org_manager scoped to the token's org_id.
 *
 * Audit: writes `event_type='token_regenerated'` with both old + new ids
 * in `details`. Single audit row (NOT one for revoke + one for generate);
 * the regenerate is the operator's single intent.
 */
export async function POST(
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

  if (!(await currentUserCanAccessOrg(supabase, row.org_id))) {
    return NextResponse.json(
      { error: "Not authorized to manage tokens for this organization." },
      { status: 403 }
    );
  }

  if (row.revoked_at !== null) {
    return NextResponse.json(
      {
        error:
          "This token is already revoked. Generate a fresh token instead.",
      },
      { status: 409 }
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

  // ── Step 1: revoke old (race-safe — IS NULL guard catches concurrent revoke).
  const { error: updErr, count } = await supabase
    .from("org_api_tokens")
    .update({ revoked_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", id)
    .is("revoked_at", null);

  if (updErr) {
    if (updErr.code === "42501" || updErr.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to manage tokens for this organization." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to revoke old token: ${updErr.message}` },
      { status: 500 }
    );
  }
  if (count === 0) {
    // Concurrent revoke beat us to it.
    return NextResponse.json(
      {
        error:
          "This token was revoked by another action. Generate a fresh token instead.",
      },
      { status: 409 }
    );
  }

  // ── Step 2: generate + insert new (same name + org_id).
  const t = generateToken();
  const hash = await t.hashPromise;

  const { data: newRow, error: insErr } = await supabase
    .from("org_api_tokens")
    .insert({
      org_id: row.org_id,
      name: row.name,
      token_lookup: t.lookup,
      token_hash: hash,
      env_prefix: t.envPrefix,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (insErr) {
    // Partial failure: old is revoked, new is not created. Surface a
    // distinct error so the operator can retry via "Generate".
    return NextResponse.json(
      {
        error: `Old token revoked but new token failed to create: ${insErr.message}. Use Generate to create a fresh token.`,
        partial: true,
      },
      { status: 500 }
    );
  }

  const { error: auditErr } = await supabase
    .from("billing_audit_log")
    .insert({
      org_id: row.org_id,
      billing_period_id: null,
      event_type: "token_regenerated",
      actor_user_id: user.id,
      actor_kind: "human",
      actor_ref: null,
      details: {
        old_token_id: row.id,
        new_token_id: newRow.id,
        name: row.name,
      },
    });

  if (auditErr) {
    console.warn(
      JSON.stringify({
        event: "org_api_tokens.regenerate.audit_write_failed",
        old_token_id: row.id,
        new_token_id: newRow.id,
        org_id: row.org_id,
        pg_code: auditErr.code,
        pg_message: auditErr.message,
        at: new Date().toISOString(),
      })
    );
  }

  revalidatePath("/settings/api-tokens");

  return NextResponse.json(
    { id: newRow.id, plaintext: t.plaintext },
    { status: 201 }
  );
}
