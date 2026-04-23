import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { EdgeDataSource } from "@/lib/types/domain";
import { EDGE_DATA_SOURCE_VALUES } from "@/lib/types/domain";

// Derive valid enum values at runtime from the generated DB constants.
const VALID_DATA_SOURCE_TYPES = EDGE_DATA_SOURCE_VALUES;

function isValidDataSource(v: unknown): v is EdgeDataSource {
  return VALID_DATA_SOURCE_TYPES.includes(v as EdgeDataSource);
}

/**
 * Validates and parses a URL string.
 * Returns null if valid, or an error message string if invalid.
 */
function validateUrl(raw: string): string | null {
  if (raw !== raw.trim()) {
    return "URL must not have leading or trailing spaces.";
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return "Invalid URL format.";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "URL must use http or https protocol.";
  }
  if (parsed.username || parsed.password) {
    return "URL must not contain embedded credentials.";
  }
  return null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/edges/[id]
 *
 * Updates an existing edge row. Authorization enforced by RLS on `edges`.
 * Postgres `42501` → HTTP 403.
 *
 * Special rule: if request changes `data_source_type` AND ≥1 child device
 * exists, reject with 409 so the operator removes/reassigns them first.
 *
 * Request body (all fields optional):
 * {
 *   name?: string;
 *   data_source_type?: EdgeDataSource;
 *   openems_backend_url?: string | null;
 *   openems_edge_id?: string | null;
 *   role?: string | null;
 * }
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

  const {
    name,
    data_source_type,
    openems_backend_url,
    openems_edge_id,
    role,
  } = body as Record<string, unknown>;

  // At least one field must be provided
  const hasName = name !== undefined;
  const hasDataSource = data_source_type !== undefined;
  const hasUrl = openems_backend_url !== undefined;
  const hasEdgeId = openems_edge_id !== undefined;
  const hasRole = role !== undefined;

  if (!hasName && !hasDataSource && !hasUrl && !hasEdgeId && !hasRole) {
    return NextResponse.json({ error: "No fields provided to update" }, { status: 400 });
  }

  // Validate fields if provided
  if (hasName && (typeof name !== "string" || !name.trim())) {
    return NextResponse.json({ error: "name must be a non-empty string" }, { status: 422 });
  }

  if (hasDataSource && !isValidDataSource(data_source_type)) {
    return NextResponse.json(
      { error: `data_source_type must be one of: ${VALID_DATA_SOURCE_TYPES.join(", ")}` },
      { status: 422 }
    );
  }

  const supabase = await createClient();

  // Fetch the current edge row — needed to:
  //   (a) detect data_source_type change
  //   (b) validate OpenEMS fields against the effective data_source_type
  // RLS on edges applies here: if user can't read it, they can't update it.
  const { data: currentEdge, error: fetchError } = await supabase
    .from("edges")
    .select("id, data_source_type, name")
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

  // Effective data_source_type after the patch
  const effectiveDataSource: EdgeDataSource = hasDataSource
    ? (data_source_type as EdgeDataSource)
    : (currentEdge.data_source_type as EdgeDataSource);

  // Validate OpenEMS fields against effective data source
  if (effectiveDataSource === "openems") {
    // If the patch sets openems_backend_url to something, validate it
    if (hasUrl && openems_backend_url !== null) {
      if (typeof openems_backend_url !== "string" || !openems_backend_url.trim()) {
        return NextResponse.json(
          { error: "openems_backend_url must be a non-empty string or null" },
          { status: 422 }
        );
      }
      const urlError = validateUrl(openems_backend_url.trim());
      if (urlError) {
        return NextResponse.json(
          { error: `openems_backend_url: ${urlError}` },
          { status: 422 }
        );
      }
    }
  }

  // Check for re-classification with child devices
  const isChangingDataSource =
    hasDataSource &&
    (data_source_type as EdgeDataSource) !== currentEdge.data_source_type;

  if (isChangingDataSource) {
    const { count, error: countError } = await supabase
      .from("devices")
      .select("id", { count: "exact", head: true })
      .eq("edge_id", id);

    if (countError) {
      return NextResponse.json(
        { error: `Failed to check devices: ${countError.message}` },
        { status: 500 }
      );
    }

    const deviceCount = count ?? 0;
    if (deviceCount > 0) {
      return NextResponse.json(
        {
          error: `Cannot change data source: ${deviceCount} device${deviceCount === 1 ? "" : "s"} are linked. Remove or reassign them first.`,
        },
        { status: 409 }
      );
    }
  }

  // Build the update payload — only include fields that were provided
  const updateRow: Record<string, unknown> = {};

  if (hasName && typeof name === "string") updateRow.name = name.trim();
  if (hasDataSource) updateRow.data_source_type = data_source_type;

  if (hasUrl) {
    updateRow.openems_backend_url =
      openems_backend_url === null || (typeof openems_backend_url === "string" && !openems_backend_url.trim())
        ? null
        : typeof openems_backend_url === "string"
        ? openems_backend_url.trim()
        : null;
  }

  if (hasEdgeId) {
    updateRow.openems_edge_id =
      openems_edge_id === null || (typeof openems_edge_id === "string" && !openems_edge_id.trim())
        ? null
        : typeof openems_edge_id === "string"
        ? openems_edge_id.trim()
        : null;
  }

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
    .select("id, name, data_source_type, openems_edge_id, openems_backend_url, role, microgrid_id, created_at")
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
