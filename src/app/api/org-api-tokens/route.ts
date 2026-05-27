import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";
import { generateToken } from "@/lib/internal-auth";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/org-api-tokens — generate a per-org API token (#256).
 *
 * Body: { name: string, org_id: UUID }
 * Returns (201): { id: string, plaintext: string }
 *   • plaintext is returned ONCE — there is no other surface that can
 *     retrieve it. After this response, all the operator sees is the
 *     row's name + lookup prefix + created_at + last_used_at.
 *
 * Authorization: `currentUserCanAccessOrg(org_id)` — super_admin or the
 * org_manager scoped to that org. Defense-in-depth ahead of the RLS
 * INSERT policy (which would itself reject the row).
 *
 * Audit: writes a `billing_audit_log` row with event_type='token_generated',
 * actor_kind='human', actor_user_id=auth.uid(), org_id=<token's org>.
 * Warn-but-still-return on audit failure: a missed audit row must not
 * mask a successfully created token from the operator.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const orgId = typeof body.org_id === "string" ? body.org_id : "";
  if (!UUID_RE.test(orgId)) {
    return NextResponse.json(
      { error: "Invalid org_id — expected UUID.", field: "org_id" },
      { status: 400 }
    );
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json(
      { error: "Name is required.", field: "name" },
      { status: 422 }
    );
  }
  if (name.length > 120) {
    return NextResponse.json(
      { error: "Name must be 120 characters or fewer.", field: "name" },
      { status: 422 }
    );
  }

  const supabase = await createClient();

  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    return NextResponse.json(
      { error: "Not authorized to manage tokens for this organization." },
      { status: 403 }
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

  // ── Generate + hash ─────────────────────────────────────────────────────
  const t = generateToken();
  const hash = await t.hashPromise;

  const { data, error } = await supabase
    .from("org_api_tokens")
    .insert({
      org_id: orgId,
      name,
      token_lookup: t.lookup,
      token_hash: hash,
      env_prefix: t.envPrefix,
      created_by: user.id,
    })
    .select("id")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to manage tokens for this organization." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to generate token: ${error.message}` },
      { status: 500 }
    );
  }

  // ── Audit ───────────────────────────────────────────────────────────────
  const { error: auditErr } = await supabase
    .from("billing_audit_log")
    .insert({
      org_id: orgId,
      billing_period_id: null,
      event_type: "token_generated",
      actor_user_id: user.id,
      actor_kind: "human",
      actor_ref: null,
      details: { org_api_token_id: data.id, name },
    });

  if (auditErr) {
    console.warn(
      JSON.stringify({
        event: "org_api_tokens.generate.audit_write_failed",
        org_api_token_id: data.id,
        org_id: orgId,
        pg_code: auditErr.code,
        pg_message: auditErr.message,
        at: new Date().toISOString(),
      })
    );
  }

  revalidatePath("/settings/api-tokens");

  return NextResponse.json(
    { id: data.id, plaintext: t.plaintext },
    { status: 201 }
  );
}
