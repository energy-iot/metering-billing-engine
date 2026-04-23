import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessCommunity } from "@/lib/auth/access";
import { countEntityDescendants } from "@/lib/entity-descendants";
import {
  errorBody,
  mapPgError,
  resolveActorRole,
  UUID_RE,
  type EntityDeleteLogPayload,
} from "@/lib/entity-deletion/shared";

/**
 * PATCH /api/communities/[id] — update a community (#76).
 *
 * Dirty-fields semantics: only keys present in body are applied. Re-parenting
 * via `org_id` is NOT supported through this endpoint — ignored if present.
 *
 * Authorization: `currentUserCanAccessCommunity()` — super_admin or the
 * org_manager of the community's parent org.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid community id — expected UUID." },
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

  if (!(await currentUserCanAccessCommunity(supabase, id))) {
    return NextResponse.json(
      { error: "Not authorized to update this community." },
      { status: 403 }
    );
  }

  const updates: Record<string, string | null> = {};

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json(
        { error: "Name is required.", field: "name" },
        { status: 422 }
      );
    }
    updates.name = body.name.trim();
  }

  const OPTIONAL_STRING_FIELDS = [
    "address_line1",
    "address_line2",
    "address_city",
    "address_region",
    "address_country",
    "address_postal_code",
    "geography_notes",
  ] as const;

  for (const f of OPTIONAL_STRING_FIELDS) {
    if (f in body) {
      const v = body[f];
      updates[f] = typeof v === "string" && v.trim() ? v.trim() : null;
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No fields to update." },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("communities")
    .update(updates)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this community." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update community: ${error.message}` },
      { status: 500 }
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "Community not found." },
      { status: 404 }
    );
  }

  return NextResponse.json({ community: data }, { status: 200 });
}

// ══════════════════════════════════════════════════════════════════════════
// Entity deletion (#89) — see ./delete-preview/route.ts for the preview GET.
// ══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/communities/[id] — delete a community (#89).
 *
 * Authorization: super_admin OR org_manager with access to the community's
 * parent org (AC-ROUTE-2 step 2). Uses `currentUserCanAccessCommunity`.
 *
 * Cascade policy (trust-preview per AC-ROUTE-6): no pre-DELETE re-count;
 * the UI friction layer is the safety net. See organization DELETE header
 * for full rationale; the identical pattern applies here.
 *
 * Idempotency: first-delete wins, repeats 404 (AC-ROUTE-7).
 *
 * Cascade chain: communities → microgrids → (edges/devices/households/
 * billing_periods/billing_line_items/rate_schedules/household_devices/
 * household_users). No user_roles interaction (user_roles are org-scoped,
 * not community-scoped) — the cascade-bypass GUC is still set to stay
 * consistent with the other entity DELETE routes and to future-proof if
 * role scopes ever extend below org level.
 *
 * Revalidation (AC-UI-6): both `/organizations/<org_id>` and `/communities`
 * layouts are busted so nested nav + top-level community list refresh.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      errorBody("Invalid community id — expected UUID."),
      { status: 400 }
    );
  }

  const supabase = await createClient();

  if (!(await currentUserCanAccessCommunity(supabase, id))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this community."),
      { status: 403 }
    );
  }

  const { data: community, error: fetchErr } = await supabase
    .from("communities")
    .select("id, name, org_id")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; org_id: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "community");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!community) {
    return NextResponse.json(errorBody("Community not found."), { status: 404 });
  }
  if (!community.name || !community.name.trim()) {
    return NextResponse.json(
      errorBody("Unnamed entity cannot be typed-to-confirm."),
      { status: 409 }
    );
  }

  const descendantCounts = await countEntityDescendants(
    supabase,
    "community",
    id
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorRole = await resolveActorRole(supabase);
  if (!user || !actorRole) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this community."),
      { status: 403 }
    );
  }

  const { data: rowsDeleted, error: delErr } = await supabase.rpc(
    "fn_entity_delete_community",
    { p_id: id }
  );

  if (delErr) {
    const mapped = mapPgError(delErr, "community");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if ((rowsDeleted ?? 0) === 0) {
    return NextResponse.json(errorBody("Community not found."), { status: 404 });
  }

  const payload: EntityDeleteLogPayload = {
    event: "entity.delete",
    entity_kind: "community",
    entity_id: id,
    entity_name: community.name,
    actor_user_id: user.id,
    actor_role: actorRole,
    descendant_counts: descendantCounts,
    at: new Date().toISOString(),
  };
  console.info(JSON.stringify(payload));

  revalidatePath(`/organizations/${community.org_id}`, "layout");
  revalidatePath("/communities", "layout");

  return new NextResponse(null, { status: 204 });
}
