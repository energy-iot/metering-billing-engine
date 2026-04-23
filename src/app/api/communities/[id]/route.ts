import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessCommunity } from "@/lib/auth/access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
