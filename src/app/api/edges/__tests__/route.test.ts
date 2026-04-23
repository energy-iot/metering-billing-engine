/**
 * /api/edges + /api/edges/[id] — unit tests (post-#101).
 *
 * POST /api/edges: retired — returns 410 Gone with migration pointer.
 * PATCH /api/edges/[id]:
 *   - Happy path (name-only) → 200
 *   - Rejects legacy fields `data_source_type` / `openems_backend_url` → 400
 *   - Missing all fields → 400
 *   - Empty name → 422
 *   - RLS violation on update → 403
 *   - Bad UUID → 400
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

type MockChain = {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
  // So `await chain` resolves to whatever single returns — in case the route
  // awaits without calling .single() (it doesn't here, but harmless).
  then?: never;
};

function makeChain(): MockChain {
  const chain: MockChain = {
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    single: vi.fn().mockResolvedValue({ data: null, error: null }),
  };
  chain.select.mockReturnValue(chain);
  chain.update.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

let getChain: MockChain;
let patchChain: MockChain;

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

const EDGE_UUID = "660e8400-e29b-41d4-a716-446655440001";
const BAD_ID = "not-a-uuid";

function makePatchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/edges/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/edges (retired)", () => {
  it("returns 410 Gone pointing at the Discover + register flow", async () => {
    const { POST } = await import("../route");
    const res = await POST();
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toContain("Manual edge creation is no longer supported");
    expect(json.error).toContain("discover");
    expect(json.error).toContain("register");
  });
});

describe("PATCH /api/edges/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChain = makeChain();
    patchChain = makeChain();

    // The route calls .from("edges") twice:
    //   1st — fetch the current row (select/eq/single).
    //   2nd — update(...).eq(...).select(...).single().
    // We dispatch based on call index rather than mockReturnValueOnce so
    // tests that don't reach the second call still work.
    let callIndex = 0;
    mockFrom.mockImplementation(() => {
      callIndex += 1;
      return callIndex === 1 ? getChain : patchChain;
    });
  });

  it("returns 400 for bad UUID", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatchRequest(BAD_ID, { name: "x" }), {
      params: Promise.resolve({ id: BAD_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatchRequest(EDGE_UUID, {}), {
      params: Promise.resolve({ id: EDGE_UUID }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects legacy data_source_type with 400 + pointer", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatchRequest(EDGE_UUID, { data_source_type: "modbus_direct" }),
      { params: Promise.resolve({ id: EDGE_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("data_source_type");
    expect(json.error).toContain("PUT /api/microgrids");
  });

  it("rejects legacy openems_backend_url with 400", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatchRequest(EDGE_UUID, { openems_backend_url: "http://x" }),
      { params: Promise.resolve({ id: EDGE_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("openems_backend_url");
  });

  it("returns 422 when name is empty", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatchRequest(EDGE_UUID, { name: "   " }), {
      params: Promise.resolve({ id: EDGE_UUID }),
    });
    expect(res.status).toBe(422);
  });

  it("returns 200 on happy path (name only)", async () => {
    // Fetch returns current row.
    getChain.single.mockResolvedValueOnce({
      data: { id: EDGE_UUID, name: "Old name" },
      error: null,
    });
    // Update returns the saved row.
    patchChain.single.mockResolvedValueOnce({
      data: {
        id: EDGE_UUID,
        name: "New name",
        openems_edge_id: "edge0",
        role: null,
        microgrid_id: "mg-1",
        created_at: "2026-04-23T00:00:00Z",
      },
      error: null,
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatchRequest(EDGE_UUID, { name: "New name" }), {
      params: Promise.resolve({ id: EDGE_UUID }),
    });
    expect(res.status).toBe(200);

    // Only `name` landed in the update payload — no legacy fields.
    expect(patchChain.update).toHaveBeenCalledWith({ name: "New name" });
  });

  it("returns 403 when RLS blocks the update (42501)", async () => {
    getChain.single.mockResolvedValueOnce({
      data: { id: EDGE_UUID, name: "Old" },
      error: null,
    });
    patchChain.single.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "new row violates row-level security policy for table edges",
      },
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatchRequest(EDGE_UUID, { name: "x" }), {
      params: Promise.resolve({ id: EDGE_UUID }),
    });
    expect(res.status).toBe(403);
  });
});
