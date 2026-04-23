import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/users/[id]/profile — partial profile update (UX5 / #79).
 *
 * Dirty-fields semantics: only keys present in the body are updated.
 *
 * Authorization: the user_profiles UPDATE RLS policy is the authoritative
 * gate — "self edits self OR super_admin edits anyone". Org_managers
 * cannot edit other people's profiles. If the UPDATE affects 0 rows the
 * caller lacked permission (or the target doesn't exist) — convert to
 * 403 rather than 404 to avoid existence oracles.
 *
 * Uses the user-bound server client (never the service-role client).
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = await createClient();

  // Build PATCH payload from present keys only.
  const updates: Record<string, string | null> = {};
  for (const field of ["first_name", "last_name", "phone"] as const) {
    if (field in body) {
      const v = body[field];
      if (v === null) {
        updates[field] = null;
      } else if (typeof v === "string") {
        const trimmed = v.trim();
        updates[field] = trimmed === "" ? null : trimmed;
      } else {
        return NextResponse.json(
          { error: `${field} must be a string or null.`, field },
          { status: 422 }
        );
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No updatable fields in request body." },
      { status: 422 }
    );
  }

  const { data, error } = await supabase
    .from("user_profiles")
    .update(updates)
    .eq("user_id", id)
    .select("*");

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this profile." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update profile: ${error.message}` },
      { status: 500 }
    );
  }

  // RLS SELECT filter may return zero rows even when the UPDATE itself
  // succeeded — but in practice the UPDATE policy is stricter than the
  // SELECT policy, so 0 rows here means "not authorized or no profile row".
  //
  // Migration 00017 adds a backfill + AFTER INSERT trigger that guarantees a
  // user_profiles row exists for every auth.users row. Reaching this branch
  // post-migration indicates a genuine data integrity problem (trigger failure,
  // manual deletion, etc.) — return a generic 500 rather than a misleading
  // re-invite message. The "not yours to edit" 403 is handled by the RLS
  // policy error path above (code 42501).
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: "Internal error. Please contact an administrator." },
      { status: 500 }
    );
  }

  return NextResponse.json({ profile: data[0] }, { status: 200 });
}
