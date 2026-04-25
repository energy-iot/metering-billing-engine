import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { validateCurrency } from "@/lib/validation/currency";
import { countEntityDescendants } from "@/lib/entity-descendants";
import {
  errorBody,
  mapPgError,
  resolveActorRole,
  UUID_RE,
  type EntityDeleteLogPayload,
} from "@/lib/entity-deletion/shared";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";

/**
 * PATCH /api/microgrids/[id] — update a microgrid (#76).
 *
 * Dirty-fields semantics: only keys present in body are applied.
 * Re-parenting via `community_id` is NOT supported through this endpoint —
 * ignored if present (would be a "move" feature, deferred).
 *
 * Authorization: `currentUserCanAccessMicrogrid()` — super_admin or the
 * org_manager of the microgrid's parent org (via community → org).
 *
 * Validation: currency (if sent) must be valid ISO 4217 (422 on RangeError).
 * Duplicate rename (same community → same name) → 409 with exact copy.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      { error: "Invalid microgrid id — expected UUID." },
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

  if (!(await currentUserCanAccessMicrogrid(supabase, id))) {
    return NextResponse.json(
      { error: "Not authorized to update this microgrid." },
      { status: 403 }
    );
  }

  const updates: Record<string, string | number | null> = {};

  if ("name" in body) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      return NextResponse.json(
        { error: "Name is required.", field: "name" },
        { status: 422 }
      );
    }
    updates.name = body.name.trim();
  }

  if ("currency" in body) {
    const c = typeof body.currency === "string" ? body.currency.trim() : "";
    const err = validateCurrency(c);
    if (err) {
      return NextResponse.json(
        { error: err, field: "currency" },
        { status: 422 }
      );
    }
    updates.currency = c;
  }

  const OPTIONAL_STRING_FIELDS = [
    "address_line1",
    "address_line2",
    "address_city",
    "address_region",
    "address_country",
    "address_postal_code",
  ] as const;

  for (const f of OPTIONAL_STRING_FIELDS) {
    if (f in body) {
      const v = body[f];
      updates[f] = typeof v === "string" && v.trim() ? v.trim() : null;
    }
  }

  for (const f of ["lat", "lng"] as const) {
    if (f in body) {
      const v = body[f];
      if (v === null || v === "") {
        updates[f] = null;
      } else if (typeof v === "number" && Number.isFinite(v)) {
        updates[f] = v;
      } else if (typeof v === "string" && v.trim()) {
        const parsed = Number(v);
        if (!Number.isFinite(parsed)) {
          return NextResponse.json(
            { error: `Invalid ${f} value.`, field: f },
            { status: 422 }
          );
        }
        updates[f] = parsed;
      } else {
        updates[f] = null;
      }
    }
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(
      { error: "No fields to update." },
      { status: 400 }
    );
  }

  const { data, error } = await supabase
    .from("microgrids")
    .update(updates)
    .eq("id", id)
    .select(MICROGRID_PUBLIC_COLUMNS)
    .maybeSingle();

  if (error) {
    if (
      error.code === "23505" &&
      error.message.includes("microgrids_community_name_unique")
    ) {
      const name = typeof updates.name === "string" ? updates.name : "";
      return NextResponse.json(
        {
          error: `A microgrid named '${name}' already exists in this community.`,
          field: "name",
        },
        { status: 409 }
      );
    }
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this microgrid." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to update microgrid: ${error.message}` },
      { status: 500 }
    );
  }

  if (!data) {
    return NextResponse.json(
      { error: "Microgrid not found." },
      { status: 404 }
    );
  }

  return NextResponse.json({ microgrid: data }, { status: 200 });
}

// ══════════════════════════════════════════════════════════════════════════
// Entity deletion (#89) — see ./delete-preview/route.ts for the preview GET.
// ══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/microgrids/[id] — delete a microgrid (#89).
 *
 * Authorization: super_admin OR org_manager with access to the microgrid's
 * parent org (AC-ROUTE-2 step 2).
 *
 * Cascade policy (trust-preview per AC-ROUTE-6): intentional data loss
 * warning per AC-ROUTE-8 — deleting a microgrid while a `draft` billing
 * period is active destroys in-progress meter readings + line items that
 * have not yet been finalized. This is acceptable: the blast-radius dialog
 * surfaces draft vs closed counts distinctly and the operator committed
 * to "destroy everything under {name}" by typing the name.
 *
 * Idempotency: first-delete wins, repeats 404 (AC-ROUTE-7).
 *
 * Revalidation (AC-UI-6): both `/communities/<community_id>` and
 * `/microgrids` layouts are busted.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(
      errorBody("Invalid microgrid id — expected UUID."),
      { status: 400 }
    );
  }

  const supabase = await createClient();

  if (!(await currentUserCanAccessMicrogrid(supabase, id))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this microgrid."),
      { status: 403 }
    );
  }

  const { data: microgrid, error: fetchErr } = await supabase
    .from("microgrids")
    .select("id, name, community_id")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; community_id: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "microgrid");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!microgrid) {
    return NextResponse.json(errorBody("Microgrid not found."), { status: 404 });
  }
  if (!microgrid.name || !microgrid.name.trim()) {
    return NextResponse.json(
      errorBody("Unnamed entity cannot be typed-to-confirm."),
      { status: 409 }
    );
  }

  const descendantCounts = await countEntityDescendants(supabase, "microgrid", id);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorRole = await resolveActorRole(supabase);
  if (!user || !actorRole) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this microgrid."),
      { status: 403 }
    );
  }

  const { data: rowsDeleted, error: delErr } = await supabase.rpc(
    "fn_entity_delete_microgrid",
    { p_id: id }
  );

  if (delErr) {
    const mapped = mapPgError(delErr, "microgrid");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if ((rowsDeleted ?? 0) === 0) {
    return NextResponse.json(errorBody("Microgrid not found."), { status: 404 });
  }

  const payload: EntityDeleteLogPayload = {
    event: "entity.delete",
    entity_kind: "microgrid",
    entity_id: id,
    entity_name: microgrid.name,
    actor_user_id: user.id,
    actor_role: actorRole,
    descendant_counts: descendantCounts,
    at: new Date().toISOString(),
  };
  console.info(JSON.stringify(payload));

  revalidatePath(`/communities/${microgrid.community_id}`, "layout");
  revalidatePath("/microgrids", "layout");

  return new NextResponse(null, { status: 204 });
}
