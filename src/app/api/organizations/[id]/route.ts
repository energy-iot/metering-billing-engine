import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";
import { countEntityDescendants } from "@/lib/entity-descendants";
import {
  errorBody,
  mapPgError,
  resolveActorRole,
  UUID_RE,
  type EntityDeleteLogPayload,
} from "@/lib/entity-deletion/shared";

/**
 * PATCH /api/organizations/[id] — update an organization (#76).
 *
 * Dirty-fields semantics: the client sends only changed fields. Any column NOT
 * present in the body is left untouched. The handler builds an UPDATE payload
 * from body keys only; a missing `name` key will NOT set name to null.
 *
 * Authorization: super_admin only (defense-in-depth + RLS backstop).
 *
 * Validation:
 *   - If `name` is present, it must be non-empty (422).
 *   - If `address_city` is present, it must be non-empty (422).
 *   - If `address_country` is present, it must be non-empty (422).
 *     (Org invariant: we never allow clearing city/country to null.)
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid organization id — expected UUID." },
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

  if (!(await currentUserIsSuperAdmin(supabase))) {
    return NextResponse.json(
      { error: "Only super_admin users can update organizations." },
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

  // Address fields — only include keys explicitly present in the body.
  // Required fields (city/country) cannot be cleared; optional fields may be
  // sent as "" to clear → stored as null.
  const REQUIRED_ADDR_FIELDS = ["address_city", "address_country"] as const;
  const OPTIONAL_ADDR_FIELDS = [
    "address_line1",
    "address_line2",
    "address_region",
    "address_postal_code",
  ] as const;

  for (const f of REQUIRED_ADDR_FIELDS) {
    if (f in body) {
      const v = body[f];
      if (typeof v !== "string" || !v.trim()) {
        const label = f === "address_city" ? "City" : "Country";
        return NextResponse.json(
          { error: `${label} is required.`, field: f },
          { status: 422 }
        );
      }
      updates[f] = v.trim();
    }
  }

  for (const f of OPTIONAL_ADDR_FIELDS) {
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
    .from("organizations")
    .update(updates)
    .eq("id", id)
    .select("*")
    .maybeSingle();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this organization." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update organization: ${error.message}` },
      { status: 500 }
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "Organization not found." },
      { status: 404 }
    );
  }

  return NextResponse.json({ organization: data }, { status: 200 });
}

// ══════════════════════════════════════════════════════════════════════════
// Entity deletion (#89) — GET delete-preview lives in `./delete-preview/route.ts`.
// ══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/organizations/[id] — delete an organization (#89).
 *
 * Authorization: `super_admin` only (PM decision #2 / AC-ROUTE-2 step 2).
 *
 * Cascade policy (trust-preview per AC-ROUTE-6): the DELETE does NOT re-run
 * `countEntityDescendants` pre-check. The type-to-confirm UI + blast-radius
 * dialog is the safety layer; racing new descendants in between preview and
 * confirm is acceptable — the caller has explicitly typed the name and
 * committed to "destroy everything under {name}."
 *
 * Idempotency: first-delete wins, repeats 404 (AC-ROUTE-7). Document rather
 * than chase 204-on-already-gone.
 *
 * Cascade chain: organizations → communities → microgrids → edges → devices
 * → household_devices + billing_line_items (device_id SET NULL, survives);
 * microgrids → households → household_users + household_devices; microgrids
 * → billing_periods → billing_line_items; microgrids → rate_schedules; and,
 * via 00015's new FK, organizations → user_roles (org-scoped).
 *
 * The DELETE is dispatched through `fn_entity_delete_org()` which wraps
 * `SET LOCAL app.entity_cascade_delete = 'on'` + DELETE in a single
 * transaction — required so the `user_roles` BEFORE DELETE trigger's
 * self-revoke guard doesn't roll an org_manager's own-org-delete back.
 * See 00015 header for the full rationale.
 *
 * Revalidation (AC-UI-6): `/organizations` layout is busted post-delete
 * so the sidebar/nav tree reflects the removal on next navigation.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      errorBody("Invalid organization id — expected UUID."),
      { status: 400 }
    );
  }

  const supabase = await createClient();

  // Authorization (defense-in-depth in front of RLS).
  if (!(await currentUserIsSuperAdmin(supabase))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this organization."),
      { status: 403 }
    );
  }

  // Load entity name + existence. 404 if gone; 409 if unnamed (unnamed
  // entity can't be typed-to-confirm, so the UI branch can't reach here
  // legitimately — surface a clear error).
  const { data: org, error: fetchErr } = await supabase
    .from("organizations")
    .select("id, name")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "organization");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!org) {
    return NextResponse.json(errorBody("Organization not found."), { status: 404 });
  }
  if (!org.name || !org.name.trim()) {
    return NextResponse.json(
      errorBody("Unnamed entity cannot be typed-to-confirm."),
      { status: 409 }
    );
  }

  // Pre-count descendants for the log payload (AC-LOG-1). Counts are
  // advisory per AC-ROUTE-6 — we do not re-verify against the preview.
  const descendantCounts = await countEntityDescendants(
    supabase,
    "organization",
    id
  );

  // Resolve actor metadata for the log payload. We never emit the log
  // for an unauthenticated caller (auth() already gated above), but
  // belt-and-suspenders in case the order changes.
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorRole = await resolveActorRole(supabase);
  if (!user || !actorRole) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this organization."),
      { status: 403 }
    );
  }

  // Execute DELETE via the cascade-safe RPC (see fn_entity_delete_org).
  const { data: rowsDeleted, error: delErr } = await supabase.rpc(
    "fn_entity_delete_org",
    { p_id: id }
  );

  if (delErr) {
    const mapped = mapPgError(delErr, "organization");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }

  // RLS-filtered OR already deleted → 404 (AC-ROUTE-7 idempotency).
  if ((rowsDeleted ?? 0) === 0) {
    return NextResponse.json(errorBody("Organization not found."), { status: 404 });
  }

  const payload: EntityDeleteLogPayload = {
    event: "entity.delete",
    entity_kind: "organization",
    entity_id: id,
    entity_name: org.name,
    actor_user_id: user.id,
    actor_role: actorRole,
    descendant_counts: descendantCounts,
    at: new Date().toISOString(),
  };
  console.info(JSON.stringify(payload));

  revalidatePath("/organizations", "layout");

  return new NextResponse(null, { status: 204 });
}
