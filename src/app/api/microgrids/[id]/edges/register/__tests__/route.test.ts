/**
 * POST /api/microgrids/[id]/edges/register — unit tests.
 *
 * Covers:
 *   - 400 bad UUID / empty body / malformed entries
 *   - 403 on RLS violation
 *   - Happy path: computes inserted vs updated from the prefetched existing set
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const MG_ID = "550e8400-e29b-41d4-a716-446655440000";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

function makeReq(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/microgrids/${MG_ID}/edges/register`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }
  );
}

let handlers: Array<() => unknown> = [];
let index = 0;
function registerFrom(h: () => unknown) {
  handlers.push(h);
}

describe("POST /api/microgrids/[id]/edges/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers = [];
    index = 0;
    mockFrom.mockImplementation(() => {
      const h = handlers[index++];
      if (!h) throw new Error(`unexpected from() #${index}`);
      return h();
    });
  });

  it("returns 400 for bad UUID", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeReq({ edges: [{ openems_edge_id: "e", name: "n" }] }), {
      params: Promise.resolve({ id: "not-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty edges array", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeReq({ edges: [] }), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an entry missing openems_edge_id", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeReq({ edges: [{ name: "n" }] }), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 on RLS violation during upsert", async () => {
    // 1st from: prefetch returns empty.
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          in: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }));
    // 2nd from: upsert fails with 42501.
    registerFrom(() => ({
      upsert: () => ({
        select: () =>
          Promise.resolve({
            data: null,
            error: { code: "42501", message: "rls" },
          }),
      }),
    }));

    const { POST } = await import("../route");
    const res = await POST(
      makeReq({ edges: [{ openems_edge_id: "edge0", name: "Edge 0" }] }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it("happy path: computes inserted vs updated counts from prefetched Set", async () => {
    // 1st from: prefetch — edge0 already exists, edge1 does not.
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          in: () =>
            Promise.resolve({
              data: [{ id: "db-0", openems_edge_id: "edge0" }],
              error: null,
            }),
        }),
      }),
    }));
    // 2nd from: upsert returns both rows.
    registerFrom(() => ({
      upsert: () => ({
        select: () =>
          Promise.resolve({
            data: [
              {
                id: "db-0",
                microgrid_id: MG_ID,
                openems_edge_id: "edge0",
                name: "Edge 0 (renamed)",
                role: null,
              },
              {
                id: "db-1",
                microgrid_id: MG_ID,
                openems_edge_id: "edge1",
                name: "Edge 1",
                role: null,
              },
            ],
            error: null,
          }),
      }),
    }));

    const { POST } = await import("../route");
    const res = await POST(
      makeReq({
        edges: [
          { openems_edge_id: "edge0", name: "Edge 0 (renamed)" },
          { openems_edge_id: "edge1", name: "Edge 1" },
        ],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.inserted).toBe(1);
    expect(json.updated).toBe(1);
    expect(json.edges).toHaveLength(2);
  });
});
