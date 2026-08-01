/**
 * POST /api/microgrids/[id]/openems-backend/discover — unit tests.
 *
 * Covers:
 *   - 400 bad UUID
 *   - 409 when ems_type IS NULL (not configured)
 *   - 404 when microgrid doesn't exist / RLS filters the row
 *   - 200 success path with alreadyLinked computed via prefetched Set
 *   - 200 + status='unreachable' when OpenEMS throws UNREACHABLE
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const MG_ID = "550e8400-e29b-41d4-a716-446655440000";

const getEdgesStatusMock = vi.fn();
const getMicrogridEmsConfigMock = vi.fn();

vi.mock("@/lib/openems", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openems")>(
    "@/lib/openems"
  );
  return {
    ...actual,
    createOpenEmsClient: () => ({ getEdgesStatus: getEdgesStatusMock }),
  };
});

vi.mock("@/lib/openems/config", () => ({
  getMicrogridEmsConfig: getMicrogridEmsConfigMock,
}));

let canAccessMicrogridReturn = true;

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

const mockFrom = vi.fn();
const mockGetUser = vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } });

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
}));

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/microgrids/${MG_ID}/openems-backend/discover`,
    { method: "POST" }
  );
}

// from() returns a chainable proxy that resolves terminal methods based on
// the call index and pre-registered handlers.
let handlers: Array<(table: string) => unknown> = [];
let index = 0;
function registerFrom(h: (table: string) => unknown) {
  handlers.push(h);
}

describe("POST /api/microgrids/[id]/openems-backend/discover", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers = [];
    index = 0;
    canAccessMicrogridReturn = true;
    mockFrom.mockImplementation((table: string) => {
      const h = handlers[index++];
      if (!h) throw new Error(`unexpected from(${table}) #${index}`);
      return h(table);
    });
  });

  it("returns 400 on bad UUID", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 403 — and never reaches the decrypt — when the caller cannot access the microgrid (#321)", async () => {
    canAccessMicrogridReturn = false;
    getMicrogridEmsConfigMock.mockClear();

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe(
      "You do not have permission to run OpenEMS discovery for this microgrid."
    );
    // Unreachability, not merely an error: getMicrogridEmsConfig is what
    // resolves the decrypted credential, so it must not have been called.
    expect(getMicrogridEmsConfigMock).not.toHaveBeenCalled();
  });

  it("returns 404 when microgrid is RLS-hidden or missing", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue(null);
    // probe returns null → 404.
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: null, error: null }),
        }),
      }),
    }));

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when probe finds the microgrid but ems_type is NULL", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue(null);
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({ data: { id: MG_ID }, error: null }),
        }),
      }),
    }));

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("OpenEMS Backend not configured");
  });

  it("success path: reads ems_known_edge_ids, passes to getEdgesStatus, computes alreadyLinked", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue({
      type: "direct_url",
      url: "http://localhost:8075",
    });

    // 1st from call: read ems_known_edge_ids (#112 separate query).
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { ems_known_edge_ids: ["edge0", "edge1", "edge2"] },
              error: null,
            }),
        }),
      }),
    }));
    // 2nd from call: prefetch existing edges.
    registerFrom(() => ({
      select: () => ({
        eq: () =>
          Promise.resolve({
            data: [{ openems_edge_id: "edge0" }, { openems_edge_id: "edge2" }],
            error: null,
          }),
      }),
    }));
    // 3rd from call: health update.
    registerFrom(() => ({
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }));

    getEdgesStatusMock.mockResolvedValue([
      { edgeId: "edge0", online: true },
      { edgeId: "edge1", online: false },
      { edgeId: "edge2", online: true },
    ]);

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("success");
    expect(json.edges).toHaveLength(3);
    // alreadyLinked should match the prefetched set.
    const byId = Object.fromEntries(
      (
        json.edges as Array<{
          openems_edge_id: string;
          alreadyLinked: boolean;
        }>
      ).map((e) => [e.openems_edge_id, e.alreadyLinked])
    );
    expect(byId).toEqual({ edge0: true, edge1: false, edge2: true });

    // Verify getEdgesStatus was called with the known IDs (NOT [])
    expect(getEdgesStatusMock).toHaveBeenCalledWith(["edge0", "edge1", "edge2"]);
  });

  it("empty ems_known_edge_ids → zero_edges without calling getEdgesStatus", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue({
      type: "direct_url",
      url: "http://localhost:8075",
    });

    // 1st from call: read ems_known_edge_ids → empty array.
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { ems_known_edge_ids: [] },
              error: null,
            }),
        }),
      }),
    }));
    // 2nd from call: health update.
    registerFrom(() => ({
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }));

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("zero_edges");
    expect(json.message).toContain("No edges declared yet");
    // getEdgesStatus must NOT be called
    expect(getEdgesStatusMock).not.toHaveBeenCalled();
  });

  it("maps OPENEMS_UNREACHABLE to status='unreachable'", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue({
      type: "direct_url",
      url: "http://localhost:8075",
    });

    // 1st from call: read ems_known_edge_ids.
    registerFrom(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: { ems_known_edge_ids: ["edge0"] },
              error: null,
            }),
        }),
      }),
    }));
    // 2nd from call: health-update call only (no edges prefetched since we throw first).
    registerFrom(() => ({
      update: () => ({
        eq: () => Promise.resolve({ error: null }),
      }),
    }));

    const { OpenEmsError } = await import("@/lib/openems");
    getEdgesStatusMock.mockRejectedValue(
      new OpenEmsError("down", "OPENEMS_UNREACHABLE", 503)
    );

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("unreachable");
  });
});
