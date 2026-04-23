import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { countEntityDescendants } from "@/lib/entity-descendants";
import {
  errorBody,
  mapPgError,
  resolveActorRole,
  type EntityDeleteLogPayload,
} from "@/lib/entity-deletion/shared";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/edges/[id]
 *
 * Post-#104: the body accepts only { name, role }. The following fields are
 * explicitly rejected:
 *   - `data_source_type`, `openems_backend_url` — retired in #101
 *   - `openems_edge_id` — assigned by OpenEMS Discover and is not editable.
 *     Remove the edge and rediscover to link a different OpenEMS edge.
 *
 * Authorization enforced by RLS on `edges`. Postgres `42501` → HTTP 403.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid edge ID — expected UUID" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Request body must be an object" }, { status: 400 });
  }

  const { name, role } = body as Record<string, unknown>;

  // Reject retired/immutable fields BEFORE the "no fields provided" check so
  // clients passing ONLY forbidden fields get the correct pointer message.
  const forbiddenFields = ["data_source_type", "openems_backend_url", "openems_edge_id"].filter(
    (f) => (body as Record<string, unknown>)[f] !== undefined
  );
  if (forbiddenFields.length > 0) {
    // Produce the most specific error message for the most actionable field.
    if ((body as Record<string, unknown>)["openems_edge_id"] !== undefined) {
      return NextResponse.json(
        {
          error:
            "openems_edge_id is no longer editable via PATCH. Remove and rediscover the edge to link a different OpenEMS edge.",
        },
        { status: 400 }
      );
    }
    return NextResponse.json(
      {
        error: `Legacy fields are no longer accepted: ${forbiddenFields.join(", ")}. OpenEMS is the only supported type and backend URL lives on the microgrid (see PUT /api/microgrids/[id]/openems-backend).`,
      },
      { status: 400 }
    );
  }

  // At least one supported field must be provided.
  const hasName = name !== undefined;
  const hasRole = role !== undefined;

  if (!hasName && !hasRole) {
    return NextResponse.json({ error: "No fields provided to update" }, { status: 400 });
  }

  // Validate fields if provided.
  if (hasName && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "name must be a non-empty string" }, { status: 422 });
  }

  const supabase = await createClient();

  // Fetch current row (RLS-filtered) for 404 semantics.
  const { data: currentEdge, error: fetchError } = await supabase
    .from("edges")
    .select("id, name")
    .eq("id", id)
    .single();

  if (fetchError || !currentEdge) {
    if (fetchError?.code === "PGRST116") {
      return NextResponse.json({ error: "Edge not found" }, { status: 404 });
    }
    return NextResponse.json(
      { error: fetchError?.message ?? "Edge not found" },
      { status: 404 }
    );
  }

  // Build the update payload — only include fields that were provided.
  // openems_edge_id is intentionally excluded: it is assigned by Discover and
  // is immutable via this endpoint (rejected above as a forbidden field).
  const updateRow: Record<string, unknown> = {};

  if (hasName && typeof name === "string") updateRow.name = name.trim();
  if (hasRole) {
    updateRow.role =
      role === null || (typeof role === "string" && !role.trim())
        ? null
        : typeof role === "string"
        ? role.trim()
        : null;
  }

  const { data, error } = await supabase
    .from("edges")
    .update(updateRow)
    .eq("id", id)
    .select("id, name, openems_edge_id, role, microgrid_id, created_at")
    .single();

  if (error) {
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to update this edge" },
        { status: 403 }
      );
    }

    if (error.code === "23505") {
      if (
        error.message.includes("openems_edge_id") ||
        (error as { details?: string }).details?.includes("openems_edge_id")
      ) {
        return NextResponse.json(
          {
            error:
              "An edge with this OpenEMS edge ID is already registered for this microgrid.",
          },
          { status: 409 }
        );
      }
      const edgeName = typeof name === "string" ? name.trim() : currentEdge.name;
      return NextResponse.json(
        {
          error: `An edge named '${edgeName}' already exists on this microgrid.`,
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: `Failed to update edge: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ edge: data }, { status: 200 });
}

// ══════════════════════════════════════════════════════════════════════════
// Entity deletion (#89) — see ./delete-preview/route.ts for the preview GET.
// ══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/edges/[id] — delete an edge (#89). Unchanged from the original.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  const { id } = await params;

  if (!UUID_RE.test(id)) {
    return NextResponse.json(errorBody("Invalid edge id — expected UUID."), {
      status: 400,
    });
  }

  const supabase = await createClient();

  const { data: edge, error: fetchErr } = await supabase
    .from("edges")
    .select("id, name, microgrid_id")
    .eq("id", id)
    .maybeSingle<{ id: string; name: string; microgrid_id: string }>();

  if (fetchErr) {
    const mapped = mapPgError(fetchErr, "edge");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if (!edge) {
    return NextResponse.json(errorBody("Edge not found."), { status: 404 });
  }

  if (!(await currentUserCanAccessMicrogrid(supabase, edge.microgrid_id))) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this edge."),
      { status: 403 }
    );
  }

  if (!edge.name || !edge.name.trim()) {
    return NextResponse.json(
      errorBody("Unnamed entity cannot be typed-to-confirm."),
      { status: 409 }
    );
  }

  const descendantCounts = await countEntityDescendants(supabase, "edge", id);

  const {
    data: { user },
  } = await supabase.auth.getUser();
  const actorRole = await resolveActorRole(supabase);
  if (!user || !actorRole) {
    return NextResponse.json(
      errorBody("You do not have permission to delete this edge."),
      { status: 403 }
    );
  }

  const { data: rowsDeleted, error: delErr } = await supabase.rpc(
    "fn_entity_delete_edge",
    { p_id: id }
  );

  if (delErr) {
    const mapped = mapPgError(delErr, "edge");
    return NextResponse.json(errorBody(mapped.message), { status: mapped.status });
  }
  if ((rowsDeleted ?? 0) === 0) {
    return NextResponse.json(errorBody("Edge not found."), { status: 404 });
  }

  const payload: EntityDeleteLogPayload = {
    event: "entity.delete",
    entity_kind: "edge",
    entity_id: id,
    entity_name: edge.name,
    actor_user_id: user.id,
    actor_role: actorRole,
    descendant_counts: descendantCounts,
    at: new Date().toISOString(),
  };
  console.info(JSON.stringify(payload));

  revalidatePath(`/microgrids/${edge.microgrid_id}`, "layout");

  return new NextResponse(null, { status: 204 });
}
