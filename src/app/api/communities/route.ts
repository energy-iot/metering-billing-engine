import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessOrg } from "@/lib/auth/access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/communities — create a new community under a parent org (#76).
 *
 * Authorization: `currentUserCanAccessOrg(org_id)` — super_admin or the
 * org_manager whose scope matches `org_id`. Defense-in-depth; RLS backstop.
 *
 * Validation:
 *   - `name` (required, 422 with field='name').
 *   - `org_id` (required UUID, 400 on malformed; 403 if not accessible).
 *   - Address fields are all optional at the DB layer; UI may require city
 *     but we do not enforce that at the server for communities (Org is the
 *     stricter invariant — see POST /api/organizations).
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

  const supabase = await createClient();

  if (!(await currentUserCanAccessOrg(supabase, orgId))) {
    return NextResponse.json(
      { error: "Not authorized to add communities to this organization." },
      { status: 403 }
    );
  }

  const row = {
    org_id: orgId,
    name,
    address_line1: readOptionalString(body.address_line1),
    address_line2: readOptionalString(body.address_line2),
    address_city: readOptionalString(body.address_city),
    address_region: readOptionalString(body.address_region),
    address_country: readOptionalString(body.address_country),
    address_postal_code: readOptionalString(body.address_postal_code),
    geography_notes: readOptionalString(body.geography_notes),
  };

  const { data, error } = await supabase
    .from("communities")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to add communities to this organization." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to create community: ${error.message}` },
      { status: 500 }
    );
  }

  revalidatePath("/communities", "layout");
  revalidatePath("/microgrids", "layout");
  revalidatePath(`/organizations/${orgId}`, "layout");

  return NextResponse.json({ community: data }, { status: 201 });
}

function readOptionalString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}
