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
 * - Must parse with `new URL()` (no throw).
 * - Protocol must be http: or https:
 * - No embedded credentials (username/password in URL).
 * - No leading/trailing whitespace (caller must trim first).
 *
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

/**
 * POST /api/edges
 *
 * Creates a new edge row. Authorization is enforced by RLS via
 * `user_can_access_microgrid(microgrid_id)`. No JS pre-check.
 *
 * Request body:
 * {
 *   microgrid_id: string;
 *   name: string;
 *   data_source_type: EdgeDataSource;
 *   openems_backend_url?: string | null;
 *   openems_edge_id?: string | null;
 *   role?: string | null;
 * }
 *
 * Error mapping:
 *   42501 (Postgres RLS violation) → 403
 *   23505 (unique violation on name) → 409
 *   23505 (unique violation on openems_edge_id) → 409
 *   validation failure → 422
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
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
    microgrid_id,
    name,
    data_source_type,
    openems_backend_url,
    openems_edge_id,
    role,
  } = body as Record<string, unknown>;

  // Validate required fields
  if (typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 422 });
  }

  if (!isValidDataSource(data_source_type)) {
    return NextResponse.json(
      { error: `data_source_type must be one of: ${VALID_DATA_SOURCE_TYPES.join(", ")}` },
      { status: 422 }
    );
  }

  if (typeof microgrid_id !== "string" || !microgrid_id.trim()) {
    return NextResponse.json({ error: "microgrid_id is required" }, { status: 422 });
  }

  // OpenEMS-specific validation
  if (data_source_type === "openems") {
    if (typeof openems_backend_url !== "string" || !openems_backend_url.trim()) {
      return NextResponse.json(
        { error: "openems_backend_url is required when data_source_type is openems" },
        { status: 422 }
      );
    }
    if (typeof openems_edge_id !== "string" || !openems_edge_id.trim()) {
      return NextResponse.json(
        { error: "openems_edge_id is required when data_source_type is openems" },
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

  const supabase = await createClient();

  const insertRow: Record<string, unknown> = {
    microgrid_id: microgrid_id.trim(),
    name: name.trim(),
    data_source_type,
    openems_backend_url:
      data_source_type === "openems" && typeof openems_backend_url === "string"
        ? openems_backend_url.trim()
        : null,
    openems_edge_id:
      data_source_type === "openems" && typeof openems_edge_id === "string"
        ? openems_edge_id.trim()
        : null,
    role:
      typeof role === "string" && role.trim()
        ? role.trim()
        : null,
  };

  const { data, error } = await supabase
    .from("edges")
    .insert(insertRow)
    .select("id, name, data_source_type, openems_edge_id, openems_backend_url, role, microgrid_id, created_at")
    .single();

  if (error) {
    // RLS violation
    if (error.code === "42501" || error.message.includes("row-level security")) {
      return NextResponse.json(
        { error: "Not authorized to create an edge on this microgrid" },
        { status: 403 }
      );
    }

    // Unique constraint violation
    if (error.code === "23505") {
      // Determine which constraint was violated from the detail message
      if (error.message.includes("openems_edge_id") || (error as { details?: string }).details?.includes("openems_edge_id")) {
        return NextResponse.json(
          {
            error:
              "An edge with this OpenEMS edge ID is already registered for this microgrid.",
          },
          { status: 409 }
        );
      }
      // Default: name uniqueness constraint
      return NextResponse.json(
        {
          error: `An edge named '${name.trim()}' already exists on this microgrid.`,
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      { error: `Failed to create edge: ${error.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ edge: data }, { status: 201 });
}
