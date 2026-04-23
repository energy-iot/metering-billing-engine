import "server-only";

/**
 * Shared `delete-preview` GET handler factory (#89).
 *
 * Each of the four entity-kind routes (`organizations/[id]/delete-preview`,
 * `communities/[id]/delete-preview`, `microgrids/[id]/delete-preview`,
 * `edges/[id]/delete-preview`) imports this and wraps it with a permission
 * predicate + the matching `EntityKind` literal. Keeps the response shape
 * (incl. `as_of` + `parent` fields per AC-ROUTE-3) in lock-step across
 * surfaces.
 *
 * Response shape (AC-ROUTE-3):
 *   {
 *     entity: { id: string; name: string },
 *     descendant_counts: DescendantCounts,       // discriminated union
 *     as_of: string,                             // ISO 8601
 *     parent: Parent                             // null for organization
 *   }
 *
 * Permission parity with DELETE: AC-ROUTE-4. Exposing descendant counts
 * to a caller who can't delete would leak scope info; gate at the same
 * level as the DELETE sibling.
 */

import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  countEntityDescendants,
  type EntityKind,
} from "@/lib/entity-descendants";
import { UUID_RE, errorBody, mapPgError, resolveParent } from "./shared";

export interface PreviewHandlerOptions {
  kind: EntityKind;
  /**
   * Human-readable entity label used in error copy (`Organization not
   * found.`, `Invalid microgrid id...`). Lowercase singular.
   */
  entityLabel: string;
  /**
   * Permission predicate. Must match the DELETE sibling route's check
   * exactly (AC-ROUTE-4). Returns `true` when the caller may see counts.
   */
  canAccess: (supabase: SupabaseClient, id: string) => Promise<boolean>;
  /**
   * Returns the DB table the entity lives in (organizations, communities,
   * microgrids, edges).
   */
  table: "organizations" | "communities" | "microgrids" | "edges";
}

/**
 * Build the Next.js GET handler for a `delete-preview` route.
 */
export function buildDeletePreviewHandler(opts: PreviewHandlerOptions) {
  return async function GET(
    _request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
  ): Promise<NextResponse> {
    const { id } = await params;

    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        errorBody(`Invalid ${opts.entityLabel} id — expected UUID.`),
        { status: 400 }
      );
    }

    const supabase = await createClient();

    if (!(await opts.canAccess(supabase, id))) {
      return NextResponse.json(
        errorBody(`You do not have permission to delete this ${opts.entityLabel}.`),
        { status: 403 }
      );
    }

    // Resolve the entity name. RLS-visible only; unauthorized callers
    // were already 403'd above, so a null here means "not found."
    const { data: entity, error: fetchErr } = await supabase
      .from(opts.table)
      .select("id, name")
      .eq("id", id)
      .maybeSingle<{ id: string; name: string }>();

    if (fetchErr) {
      const mapped = mapPgError(fetchErr, opts.entityLabel);
      return NextResponse.json(errorBody(mapped.message), {
        status: mapped.status,
      });
    }
    if (!entity) {
      return NextResponse.json(
        errorBody(
          `${opts.entityLabel[0].toUpperCase()}${opts.entityLabel.slice(1)} not found.`
        ),
        { status: 404 }
      );
    }

    const [descendantCounts, parent] = await Promise.all([
      countEntityDescendants(supabase, opts.kind, id),
      resolveParent(supabase, opts.kind, id),
    ]);

    return NextResponse.json(
      {
        entity: { id: entity.id, name: entity.name },
        descendant_counts: descendantCounts,
        as_of: new Date().toISOString(),
        parent,
      },
      { status: 200 }
    );
  };
}
