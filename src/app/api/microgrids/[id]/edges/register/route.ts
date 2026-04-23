import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RegisterEdgeEntry = {
  openems_edge_id: string;
  name: string;
  role?: string | null;
};

type RegisterRequestBody = {
  edges: RegisterEdgeEntry[];
};

/**
 * POST /api/microgrids/[id]/edges/register — bulk-register discovered edges.
 *
 * Replaces the retired POST /api/edges manual-create path. Idempotent on
 * (microgrid_id, openems_edge_id) — ON CONFLICT DO UPDATE refreshes name/role.
 *
 * Permission: RLS-enforced (the edges INSERT policy runs
 * user_can_access_microgrid(microgrid_id)).
 *
 * Returns { inserted, updated, edges } where `inserted + updated` equals
 * the input edge count on success.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id: microgridId } = await params;

  if (!UUID_RE.test(microgridId)) {
    return NextResponse.json(
      { error: "Invalid microgrid id — expected UUID" },
      { status: 400 }
    );
  }

  let body: RegisterRequestBody;
  try {
    body = (await request.json()) as RegisterRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || !Array.isArray(body.edges) || body.edges.length === 0) {
    return NextResponse.json(
      { error: "Request body must include a non-empty `edges` array" },
      { status: 400 }
    );
  }

  // Validate every entry before any DB write so we return all errors at once
  // (or none, as we bail on the first malformed row).
  for (const entry of body.edges) {
    if (
      !entry ||
      typeof entry.openems_edge_id !== "string" ||
      !entry.openems_edge_id.trim() ||
      typeof entry.name !== "string" ||
      !entry.name.trim()
    ) {
      return NextResponse.json(
        {
          error:
            "Each edge must include non-empty openems_edge_id and name strings",
        },
        { status: 400 }
      );
    }
  }

  const supabase = await createClient();

  // Snapshot existing edges to compute inserted-vs-updated counts.
  const { data: existingRows, error: existingErr } = await supabase
    .from("edges")
    .select("id, openems_edge_id")
    .eq("microgrid_id", microgridId)
    .in(
      "openems_edge_id",
      body.edges.map((e) => e.openems_edge_id.trim())
    );

  if (existingErr) {
    return NextResponse.json(
      { error: `Failed to read existing edges: ${existingErr.message}` },
      { status: 500 }
    );
  }

  const existingIds = new Set(
    (existingRows ?? []).map((r) => r.openems_edge_id)
  );

  // Upsert: on conflict (microgrid_id, openems_edge_id) update name + role.
  // The UNIQUE constraint lives on 00001_schema.sql → (microgrid_id, openems_edge_id).
  const rows = body.edges.map((e) => ({
    microgrid_id: microgridId,
    openems_edge_id: e.openems_edge_id.trim(),
    name: e.name.trim(),
    role: e.role?.trim() || null,
  }));

  const { data: upserted, error: upsertErr } = await supabase
    .from("edges")
    .upsert(rows, { onConflict: "microgrid_id,openems_edge_id" })
    .select("id, microgrid_id, openems_edge_id, name, role");

  if (upsertErr) {
    if (
      upsertErr.code === "42501" ||
      upsertErr.message.includes("row-level security")
    ) {
      return NextResponse.json(
        { error: "You do not have permission to register edges on this microgrid." },
        { status: 403 }
      );
    }
    if (upsertErr.code === "23505") {
      // Unique (microgrid_id, name) — two discovered edges would collapse
      // to the same display name.
      return NextResponse.json(
        {
          error: `Two edges have the same name. Ensure each edge has a unique display name within the microgrid.`,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: `Failed to register edges: ${upsertErr.message}` },
      { status: 500 }
    );
  }

  const insertedCount = (upserted ?? []).filter(
    (r) => !existingIds.has(r.openems_edge_id)
  ).length;
  const updatedCount = (upserted ?? []).length - insertedCount;

  revalidatePath(`/microgrids/${microgridId}/setup/edges`, "page");

  return NextResponse.json(
    {
      inserted: insertedCount,
      updated: updatedCount,
      edges: upserted ?? [],
    },
    { status: 200 }
  );
}
