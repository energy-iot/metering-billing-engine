/**
 * GET /api/edges/[id]/discover-devices — unit tests (#114).
 *
 * Covers:
 *   (a) Happy path — super_admin, configured microgrid, edge online, 1 component → 200
 *   (b) Dedup — existing devices row → alreadyAdded: true
 *   (c) Bad UUID → 400
 *   (d) Edge not found → 404
 *   (e) Cross-microgrid edge (canAccessMicrogrid false) → 404
 *   (f) org_manager who can access the microgrid → 200 (post-#200 widening)
 *   (g) Microgrid unconfigured → 409 reason: "not_configured"
 *   (h) OPENEMS_FORBIDDEN from config → 403 reason: "forbidden"
 *   (i) getEdgesStatus throws OPENEMS_AUTH_FAILED → 503 reason: "auth_failed"
 *   (j) getEdgesStatus throws OPENEMS_UNREACHABLE → 503 reason: "unreachable"
 *   (k) getEdgeConfig throws (edge offline) → 200 online: false, devices: []
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const EDGE_DB_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const OPENEMS_EDGE_ID = "edge0";

// ─── Mock: openems client ───────────────────────────────────────────────────
const getEdgesStatusMock = vi.fn();
const getEdgeConfigMock = vi.fn();
const getMicrogridEmsConfigMock = vi.fn();

vi.mock("@/lib/openems", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openems")>(
    "@/lib/openems"
  );
  return {
    ...actual,
    createOpenEmsClient: () => ({
      getEdgesStatus: getEdgesStatusMock,
      getEdgeConfig: getEdgeConfigMock,
    }),
  };
});

vi.mock("@/lib/openems/config", () => ({
  getMicrogridEmsConfig: getMicrogridEmsConfigMock,
}));

// ─── Mock: auth ─────────────────────────────────────────────────────────────
let isSuperAdminReturn = true;
let canAccessMicrogridReturn = true;

vi.mock("@/lib/auth/access", () => ({
  currentUserIsSuperAdmin: async () => isSuperAdminReturn,
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

// ─── Mock: supabase ──────────────────────────────────────────────────────────
const mockFrom = vi.fn();
const mockGetUser = vi
  .fn()
  .mockResolvedValue({ data: { user: { id: "actor-user-1" } } });

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** from() chain factories registered in call order. */
let handlers: Array<(table: string) => unknown> = [];
let callIndex = 0;

function registerFrom(h: (table: string) => unknown) {
  handlers.push(h);
}

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/edges/${EDGE_DB_ID}/discover-devices`,
    { method: "GET" }
  );
}

/** Healthy edge row returned by the first from("edges") call. */
function registerEdgeLookup(found = true) {
  registerFrom(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () =>
          Promise.resolve({
            data: found
              ? {
                  id: EDGE_DB_ID,
                  microgrid_id: MICROGRID_ID,
                  openems_edge_id: OPENEMS_EDGE_ID,
                }
              : null,
            error: null,
          }),
      }),
    }),
  }));
}

/** Register the devices dedup query (second from() call after classification). */
function registerDedupQuery(matchedComponentIds: string[] = []) {
  registerFrom(() => ({
    select: () => ({
      eq: () => ({
        in: () =>
          Promise.resolve({
            data: matchedComponentIds.map((id) => ({
              openems_component_id: id,
            })),
            error: null,
          }),
      }),
    }),
  }));
}

/** A minimal valid EdgeConfig with one ElectricityMeter component. */
const singleComponentConfig = {
  components: {
    meter0: {
      alias: "Main Meter",
      factoryId: "io.openems.impl.meter.consumption.ConsumptionMeter",
      properties: {},
    },
  },
  factories: {
    "io.openems.impl.meter.consumption.ConsumptionMeter": {
      natureIds: ["io.openems.edge.meter.api.ElectricityMeter"],
    },
  },
};

const defaultEmsConfig = { type: "direct_url" as const, url: "http://localhost:8075" };

// ─── Suite ───────────────────────────────────────────────────────────────────

describe("GET /api/edges/[id]/discover-devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers = [];
    callIndex = 0;
    isSuperAdminReturn = true;
    canAccessMicrogridReturn = true;

    mockFrom.mockImplementation((table: string) => {
      const h = handlers[callIndex++];
      if (!h) throw new Error(`unexpected from(${table}) call #${callIndex}`);
      return h(table);
    });
  });

  // (c) Bad UUID
  it("(c) returns 400 on bad UUID", async () => {
    const { GET } = await import("../route");
    const req = new NextRequest(
      "http://localhost/api/edges/not-a-uuid/discover-devices",
      { method: "GET" }
    );
    const res = await GET(req, {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("UUID");
  });

  // (d) Edge not found
  it("(d) returns 404 when edge row is missing / RLS-hidden", async () => {
    registerEdgeLookup(false);

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toContain("Edge not found");
  });

  // (e) Cross-microgrid edge → 404 (not 403, avoids existence leak)
  it("(e) returns 404 when currentUserCanAccessMicrogrid is false", async () => {
    canAccessMicrogridReturn = false;
    registerEdgeLookup(true);

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(404);
  });

  // (f) org_manager who can access the microgrid → 200 (post-#200 widening).
  // The super_admin gate was removed; permission is now decided by
  // currentUserCanAccessMicrogrid + fn_get_ems_secret, both of which accept
  // org_managers scoped to the microgrid's parent org. The 403 surface is
  // now exclusive to OPENEMS_FORBIDDEN (case (h)).
  it("(f) returns 200 for org_manager who can access the microgrid", async () => {
    isSuperAdminReturn = false;
    canAccessMicrogridReturn = true;
    getMicrogridEmsConfigMock.mockResolvedValue(defaultEmsConfig);
    registerEdgeLookup(true);
    registerDedupQuery([]);

    getEdgesStatusMock.mockResolvedValue([{ edgeId: OPENEMS_EDGE_ID, online: true }]);
    getEdgeConfigMock.mockResolvedValue(singleComponentConfig);

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.edgeId).toBe(OPENEMS_EDGE_ID);
    expect(json.online).toBe(true);
    expect(json.devices).toHaveLength(1);
    expect(json.devices[0].componentId).toBe("meter0");
  });

  // (g) Microgrid unconfigured → 409
  it("(g) returns 409 when getMicrogridEmsConfig returns null (not configured)", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue(null);
    registerEdgeLookup(true);

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("not_configured");
  });

  // (h) OPENEMS_FORBIDDEN from config → 403
  it("(h) returns 403 with reason 'forbidden' when getMicrogridEmsConfig throws OPENEMS_FORBIDDEN", async () => {
    const { OpenEmsError } = await import("@/lib/openems");
    getMicrogridEmsConfigMock.mockRejectedValue(
      new OpenEmsError("Forbidden", "OPENEMS_FORBIDDEN", 403)
    );
    registerEdgeLookup(true);

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("forbidden");
  });

  // (i) getEdgesStatus throws OPENEMS_AUTH_FAILED → 503 reason: "auth_failed"
  it("(i) returns 503 with reason 'auth_failed' when getEdgesStatus throws OPENEMS_AUTH_FAILED", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue(defaultEmsConfig);
    registerEdgeLookup(true);

    const { OpenEmsError } = await import("@/lib/openems");
    getEdgesStatusMock.mockRejectedValue(
      new OpenEmsError("Auth failed", "OPENEMS_AUTH_FAILED", 401)
    );

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.reason).toBe("auth_failed");
  });

  // (j) getEdgesStatus throws OPENEMS_UNREACHABLE → 503 reason: "unreachable"
  it("(j) returns 503 with reason 'unreachable' when getEdgesStatus throws OPENEMS_UNREACHABLE", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue(defaultEmsConfig);
    registerEdgeLookup(true);

    const { OpenEmsError } = await import("@/lib/openems");
    getEdgesStatusMock.mockRejectedValue(
      new OpenEmsError("Unreachable", "OPENEMS_UNREACHABLE", 503)
    );

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.reason).toBe("unreachable");
  });

  // (k) getEdgeConfig throws (edge offline) → 200 with online:false, devices:[]
  it("(k) returns 200 with online:false and empty devices when getEdgeConfig throws (edge offline)", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue(defaultEmsConfig);
    registerEdgeLookup(true);

    getEdgesStatusMock.mockResolvedValue([{ edgeId: OPENEMS_EDGE_ID, online: false }]);
    getEdgeConfigMock.mockRejectedValue(new Error("edge offline"));

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.online).toBe(false);
    expect(json.devices).toHaveLength(0);
    expect(json.edgeId).toBe(OPENEMS_EDGE_ID);
  });

  // (a) Happy path
  it("(a) returns 200 with classified device and alreadyAdded:false", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue(defaultEmsConfig);
    registerEdgeLookup(true);
    // dedup query: no existing devices
    registerDedupQuery([]);

    getEdgesStatusMock.mockResolvedValue([{ edgeId: OPENEMS_EDGE_ID, online: true }]);
    getEdgeConfigMock.mockResolvedValue(singleComponentConfig);

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.edgeId).toBe(OPENEMS_EDGE_ID);
    expect(json.online).toBe(true);
    expect(json.devices).toHaveLength(1);

    const device = json.devices[0];
    expect(device.componentId).toBe("meter0");
    expect(device.suggestedDeviceType).toBe("consumption_meter");
    expect(device.alreadyAdded).toBe(false);
    expect(device.openemsChannelAddress).toBe("meter0/ActiveConsumptionEnergy");
  });

  // (b) Dedup: existing device → alreadyAdded: true
  it("(b) marks alreadyAdded:true when a matching devices row exists", async () => {
    getMicrogridEmsConfigMock.mockResolvedValue(defaultEmsConfig);
    registerEdgeLookup(true);
    // dedup query: meter0 already in devices table
    registerDedupQuery(["meter0"]);

    getEdgesStatusMock.mockResolvedValue([{ edgeId: OPENEMS_EDGE_ID, online: true }]);
    getEdgeConfigMock.mockResolvedValue(singleComponentConfig);

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ id: EDGE_DB_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.devices).toHaveLength(1);
    expect(json.devices[0].alreadyAdded).toBe(true);
  });
});
