import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { validateCurrency } from "@/lib/validation/currency";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    .select("*")
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
