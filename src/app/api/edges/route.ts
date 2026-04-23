import { NextResponse } from "next/server";

/**
 * POST /api/edges — retired (#101 / AC-ROUTE-4).
 *
 * Manual edge creation is no longer supported. Edges are registered via the
 * Discover flow:
 *   1. `POST /api/microgrids/[id]/openems-backend/discover` — lists the edges
 *      reported by the OpenEMS backend (unlinked + already-linked).
 *   2. `POST /api/microgrids/[id]/edges/register` — bulk-inserts the chosen
 *      edges (idempotent on `(microgrid_id, openems_edge_id)`).
 *
 * The route remains here to return a clear 410 for any stale client; once the
 * frontend-side Add Edge dialog lands (#103) this file can be deleted.
 */
export async function POST(): Promise<NextResponse> {
  return NextResponse.json(
    {
      error:
        "Manual edge creation is no longer supported. Use /api/microgrids/[id]/openems-backend/discover + /api/microgrids/[id]/edges/register.",
    },
    { status: 410 }
  );
}
