import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserIsSuperAdmin } from "@/lib/auth/access";

/**
 * POST /api/organizations — create a new organization (#76).
 *
 * Authorization:
 *   - super_admin only. Defense-in-depth: we check `currentUserIsSuperAdmin()`
 *     explicitly before the INSERT; RLS on the `organizations` table is the
 *     backstop. The explicit check gives us a clean 403 rather than a
 *     Postgres 42501 error.
 *
 * Validation:
 *   - `name` required (422 with field='name').
 *   - `address_city` AND `address_country` required (Org-level invariant for
 *     URA invoicing — surfaced here even though the DB columns are nullable).
 *
 * Error contract: { error: string, field?: string }
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const supabase = await createClient();

  // ── authz ───────────────────────────────────────────────────────────────
  if (!(await currentUserIsSuperAdmin(supabase))) {
    return NextResponse.json(
      { error: "Only super_admin users can create organizations." },
      { status: 403 }
    );
  }

  // ── validation ──────────────────────────────────────────────────────────
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json(
      { error: "Name is required.", field: "name" },
      { status: 422 }
    );
  }

  const addressCity =
    typeof body.address_city === "string" ? body.address_city.trim() : "";
  if (!addressCity) {
    return NextResponse.json(
      { error: "City is required.", field: "address_city" },
      { status: 422 }
    );
  }

  const addressCountry =
    typeof body.address_country === "string" ? body.address_country.trim() : "";
  if (!addressCountry) {
    return NextResponse.json(
      { error: "Country is required.", field: "address_country" },
      { status: 422 }
    );
  }

  const row = {
    name,
    address_line1: readOptionalString(body.address_line1),
    address_line2: readOptionalString(body.address_line2),
    address_city: addressCity,
    address_region: readOptionalString(body.address_region),
    address_country: addressCountry,
    address_postal_code: readOptionalString(body.address_postal_code),
  };

  const { data, error } = await supabase
    .from("organizations")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to create organizations." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to create organization: ${error.message}` },
      { status: 500 }
    );
  }

  revalidatePath("/organizations", "layout");

  return NextResponse.json({ organization: data }, { status: 201 });
}

function readOptionalString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}
