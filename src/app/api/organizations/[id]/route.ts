import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
