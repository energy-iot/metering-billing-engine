import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessCommunity } from "@/lib/auth/access";
import { validateCurrency } from "@/lib/validation/currency";
import { MICROGRID_PUBLIC_COLUMNS } from "@/lib/types/microgrid-columns";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * POST /api/microgrids — create a new microgrid under a parent community (#76).
 *
 * Authorization: `currentUserCanAccessCommunity()` — resolves community → org.
 * Prevents an org_manager in Org A from creating a microgrid under a community
 * that belongs to Org B.
 *
 * Validation:
 *   - `name` required (422 with field='name').
 *   - `community_id` required UUID (400 malformed; 403 if not accessible).
 *   - `currency` required + validated via Intl.NumberFormat RangeError (422).
 *
 * Duplicate-name handling: Postgres UNIQUE constraint
 * `microgrids_community_name_unique` (00008 migration) surfaces as 23505.
 * We translate that into 409 with exact copy:
 *   "A microgrid named '{name}' already exists in this community."
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const communityId =
    typeof body.community_id === "string" ? body.community_id : "";
  if (!UUID_RE.test(communityId)) {
    return NextResponse.json(
      {
        error: "Invalid community_id — expected UUID.",
        field: "community_id",
      },
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

  const currencyInput =
    typeof body.currency === "string" ? body.currency.trim() : "";
  const currencyErr = validateCurrency(currencyInput);
  if (currencyErr) {
    return NextResponse.json(
      { error: currencyErr, field: "currency" },
      { status: 422 }
    );
  }

  const supabase = await createClient();

  if (!(await currentUserCanAccessCommunity(supabase, communityId))) {
    return NextResponse.json(
      { error: "Not authorized to add microgrids to this community." },
      { status: 403 }
    );
  }

  const row = {
    community_id: communityId,
    name,
    currency: currencyInput,
    address_line1: readOptionalString(body.address_line1),
    address_line2: readOptionalString(body.address_line2),
    address_city: readOptionalString(body.address_city),
    address_region: readOptionalString(body.address_region),
    address_country: readOptionalString(body.address_country),
    address_postal_code: readOptionalString(body.address_postal_code),
    lat: readOptionalNumber(body.lat),
    lng: readOptionalNumber(body.lng),
  };

  const { data, error } = await supabase
    .from("microgrids")
    .insert(row)
    .select(MICROGRID_PUBLIC_COLUMNS)
    .single();

  if (error) {
    if (
      error.code === "23505" &&
      error.message.includes("microgrids_community_name_unique")
    ) {
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
        { error: "Not authorized to add microgrids to this community." },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: `Failed to create microgrid: ${error.message}` },
      { status: 500 }
    );
  }

  revalidatePath("/microgrids", "layout");
  revalidatePath(`/communities/${communityId}`, "layout");

  return NextResponse.json({ microgrid: data }, { status: 201 });
}

function readOptionalString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed ? trimmed : null;
}

function readOptionalNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const parsed = Number(v);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

