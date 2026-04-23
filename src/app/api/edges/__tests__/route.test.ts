/**
 * /api/edges + /api/edges/[id] — unit tests (UX4b / #77)
 *
 * All Supabase I/O is mocked — no real DB hits.
 *
 * POST /api/edges cases:
 *   (a) Happy path → 201 with edge row
 *   (b) Missing name → 422
 *   (c) Invalid data_source_type → 422
 *   (d) Missing openems_backend_url for openems type → 422
 *   (e) Invalid URL (not http/https) → 422
 *   (f) URL with embedded credentials → 422
 *   (g) Duplicate name (23505) → 409 with name message
 *   (h) Duplicate openems_edge_id (23505) → 409 with edge ID message
 *   (i) RLS violation (42501) → 403
 *
 * PATCH /api/edges/[id] cases:
 *   (j) Happy path name-only → 200; role preserved (not overwritten)
 *   (k) data_source_type change with child devices → 409
 *   (l) data_source_type change with no child devices → 200
 *   (m) RLS violation on update → 403
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Supabase mock ─────────────────────────────────────────────────────────
//
// The mock needs to chain: from(table).insert(row).select().single()
// and for PATCH: from(table).select().eq().single() + from(table).update().eq().select().single()
// and for device count: from(table).select(_, { count }).eq().single() -> returns { count }
//
// We use a chainable mock factory that returns itself for each method call,
// with the terminal .single() resolving based on what was called.

type MockChain = {
  insert: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  single: ReturnType<typeof vi.fn>;
};

// These will be assigned per-test via overrides
const insertChain = {
  select: vi.fn(),
};
insertChain.select.mockReturnValue({ single: vi.fn() });

// General chainable mock builder
function makeChain(): MockChain {
  const chain: MockChain = {
    insert: vi.fn(),
    select: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    single: vi.fn(),
  };
  chain.insert.mockReturnValue(chain);
  chain.select.mockReturnValue(chain);
  chain.update.mockReturnValue(chain);
  chain.eq.mockReturnValue(chain);
  return chain;
}

let postChain: MockChain;
let getChain: MockChain;  // for fetching current edge in PATCH
let deviceCountChain: MockChain;
let patchChain: MockChain;

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";
const EDGE_UUID = "660e8400-e29b-41d4-a716-446655440001";
const MICROGRID_UUID = "770e8400-e29b-41d4-a716-446655440002";

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/edges", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePatchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/edges/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_POST_BODY = {
  microgrid_id: MICROGRID_UUID,
  name: "Test Edge",
  data_source_type: "openems",
  openems_backend_url: "https://openems.example.com",
  openems_edge_id: "edge0",
  role: "metering",
};

// ── Tests ─────────────────────────────────────────────────────────────────

describe("POST /api/edges", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postChain = makeChain();
    mockFrom.mockReturnValue(postChain);
  });

  // (a) Happy path

  it("(a) returns 201 with edge row on valid openems payload", async () => {
    const savedEdge = {
      id: EDGE_UUID,
      microgrid_id: MICROGRID_UUID,
      name: "Test Edge",
      data_source_type: "openems",
      openems_backend_url: "https://openems.example.com",
      openems_edge_id: "edge0",
      role: "metering",
      created_at: "2026-01-01T00:00:00Z",
    };

    postChain.single.mockResolvedValueOnce({ data: savedEdge, error: null });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.edge).toMatchObject({ id: EDGE_UUID, name: "Test Edge" });
  });

  // (b) Missing name
  it("(b) returns 422 when name is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, name: "" })
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain("name is required");
  });

  // (c) Invalid data_source_type
  it("(c) returns 422 when data_source_type is invalid", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, data_source_type: "ftp_server" })
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain("data_source_type");
  });

  // (d) Missing openems_backend_url for openems type
  it("(d) returns 422 when openems_backend_url is missing for openems type", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_POST_BODY, openems_backend_url: "" })
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain("openems_backend_url is required");
  });

  // (e) Invalid URL (not http/https)
  it("(e) returns 422 when openems_backend_url uses non-http protocol", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        openems_backend_url: "ftp://openems.example.com",
      })
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain("http or https");
  });

  // (f) URL with embedded credentials
  it("(f) returns 422 when openems_backend_url has embedded credentials", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        ...VALID_POST_BODY,
        openems_backend_url: "https://user:pass@openems.example.com",
      })
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toContain("embedded credentials");
  });

  // (g) Duplicate name — 23505 on name constraint
  it("(g) returns 409 with name message on duplicate name violation", async () => {
    postChain.single.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23505",
        message:
          "duplicate key value violates unique constraint \"edges_microgrid_name_unique\"",
        details: "Key (microgrid_id, name)=(abc, Test Edge) already exists.",
      },
    });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("Test Edge");
    expect(json.error).toContain("already exists on this microgrid");
  });

  // (h) Duplicate openems_edge_id — 23505 on openems_edge_id constraint
  it("(h) returns 409 with edge ID message on duplicate openems_edge_id violation", async () => {
    postChain.single.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23505",
        message:
          "duplicate key value violates unique constraint \"edges_microgrid_id_openems_edge_id_key\"",
        details:
          "Key (microgrid_id, openems_edge_id)=(abc, edge0) already exists.",
      },
    });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("OpenEMS edge ID is already registered");
  });

  // (i) RLS violation
  it("(i) returns 403 when RLS denies the insert", async () => {
    postChain.single.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "new row violates row-level security policy for table \"edges\"",
      },
    });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_POST_BODY));

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("Not authorized");
  });
});

describe("PATCH /api/edges/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Set up chains
    getChain = makeChain();       // .from("edges").select().eq().single() → current edge
    deviceCountChain = makeChain(); // .from("devices").select(_, count).eq() → { count }
    patchChain = makeChain();     // .from("edges").update().eq().select().single()

    let callIndex = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") {
        callIndex++;
        if (callIndex === 1) return getChain;  // fetch current edge
        return patchChain;                      // update
      }
      if (table === "devices") return deviceCountChain;
      return makeChain();
    });
  });

  // (j) Name-only PATCH — role preserved
  it("(j) returns 200 on name-only PATCH; does not overwrite role", async () => {
    const currentEdge = {
      id: EDGE_UUID,
      data_source_type: "openems",
      name: "Old Name",
    };
    const updatedEdge = {
      id: EDGE_UUID,
      name: "New Name",
      data_source_type: "openems",
      role: "metering", // preserved
    };

    getChain.single.mockResolvedValueOnce({ data: currentEdge, error: null });
    patchChain.single.mockResolvedValueOnce({ data: updatedEdge, error: null });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatchRequest(EDGE_UUID, { name: "New Name" }), {
      params: Promise.resolve({ id: EDGE_UUID }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.edge.name).toBe("New Name");
    expect(json.edge.role).toBe("metering");

    // Verify update payload does NOT include `role` when it wasn't provided
    const updateCall = patchChain.update.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(updateCall).not.toHaveProperty("role");
  });

  // (k) data_source_type change with child devices → 409
  it("(k) returns 409 when changing data_source_type with child devices", async () => {
    const currentEdge = {
      id: EDGE_UUID,
      data_source_type: "openems",
      name: "Test Edge",
    };

    getChain.single.mockResolvedValueOnce({ data: currentEdge, error: null });
    // Device count returns 3
    deviceCountChain.eq.mockReturnValue({
      ...deviceCountChain,
      then: undefined,
    });
    // Override to return count
    deviceCountChain.select = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValueOnce({ count: 3, error: null }),
    });

    // Re-setup the from mock with this specific device chain
    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return getChain;
      if (table === "devices") return deviceCountChain;
      return makeChain();
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatchRequest(EDGE_UUID, {
        data_source_type: "modbus_direct",
      }),
      { params: Promise.resolve({ id: EDGE_UUID }) }
    );

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("Cannot change data source");
    expect(json.error).toContain("3 devices");
  });

  // (l) data_source_type change with no child devices → 200
  it("(l) returns 200 when changing data_source_type with no child devices", async () => {
    const currentEdge = {
      id: EDGE_UUID,
      data_source_type: "openems",
      name: "Test Edge",
    };
    const updatedEdge = {
      id: EDGE_UUID,
      data_source_type: "modbus_direct",
      name: "Test Edge",
      role: null,
    };

    getChain.single.mockResolvedValueOnce({ data: currentEdge, error: null });

    deviceCountChain.select = vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValueOnce({ count: 0, error: null }),
    });

    let edgeCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") {
        edgeCallCount++;
        if (edgeCallCount <= 1) return getChain;
        return patchChain;
      }
      if (table === "devices") return deviceCountChain;
      return makeChain();
    });

    patchChain.single.mockResolvedValueOnce({ data: updatedEdge, error: null });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatchRequest(EDGE_UUID, {
        data_source_type: "modbus_direct",
        openems_backend_url: null,
        openems_edge_id: null,
      }),
      { params: Promise.resolve({ id: EDGE_UUID }) }
    );

    expect(res.status).toBe(200);
  });

  // (m) RLS violation on PATCH
  it("(m) returns 403 when RLS denies the update", async () => {
    const currentEdge = {
      id: EDGE_UUID,
      data_source_type: "openems",
      name: "Test Edge",
    };

    getChain.single.mockResolvedValueOnce({ data: currentEdge, error: null });
    patchChain.single.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message:
          "new row violates row-level security policy for table \"edges\"",
      },
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatchRequest(EDGE_UUID, { name: "Hacked" }), {
      params: Promise.resolve({ id: EDGE_UUID }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("Not authorized");
  });
});

// ── RLS integration (cross-org denial via HTTP layer) ─────────────────────
// This mirrors the pattern in src/app/api/devices/__tests__/route.test.ts
// where we verify the 403 mapping from RLS. The actual Supabase RLS is
// verified in rls.test.ts; here we verify the HTTP response mapping.

describe("RLS: cross-org org_manager POST to /api/edges is denied", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    postChain = makeChain();
    mockFrom.mockReturnValue(postChain);
  });

  it("returns 403 when Postgres returns 42501 (row-level security policy violation)", async () => {
    postChain.single.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message:
          "new row violates row-level security policy for table \"edges\"",
      },
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: VALID_UUID, // cross-org microgrid
        name: "Unauthorized Edge",
        data_source_type: "openems",
        openems_backend_url: "https://openems.example.com",
        openems_edge_id: "edge-cross",
      })
    );

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("Not authorized");
  });
});
