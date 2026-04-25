/**
 * PATCH /api/devices/[id] — route tests (#151).
 *
 * Covers AC-12 cases:
 *   - Happy path: device_type only
 *   - Happy path: name only
 *   - Happy path: both
 *   - Idempotent PATCH (supplied values equal current values) → 200
 *   - Empty body → 400 no_changes
 *   - Body with extra field (openems_component_id) → 400 unsupported_field
 *   - Body with edge_id → 400 unsupported_field
 *   - Invalid device_type → 400 invalid_device_type
 *   - Empty/whitespace name → 400 name_required
 *   - Invalid UUID in [id] → 400
 *   - RLS-hidden device → 404
 *   - Cross-org device for org_manager → 404 (RLS hides at SELECT)
 *   - AC-CASCADE: reclassify a consumption_meter that has a primary
 *     household link → 409 device_type_role_conflict
 *   - Race protection: simulate concurrent change (UPDATE returns 0 rows) →
 *     409 device_type_changed_concurrently
 *   - Reclassify a non-consumption_meter device with no primary link → 200
 *   - Reclassify consumption_meter → consumption_meter (no type change) does
 *     NOT trigger AC-CASCADE
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Per-test mock state ─────────────────────────────────────────────────

let canAccessMicrogridReturn = true;

const mockDeviceFetchSingle = vi.fn();
const mockEdgeFetchSingle = vi.fn();
const mockHouseholdDevicesLinkSingle = vi.fn();
const mockHouseholdsFetchSingle = vi.fn();
const mockDevicesUpdateSingle = vi.fn();
const mockHouseholdDevicesAllForDevice = vi.fn();

let devicesFromCalls = 0;

const mockFrom = vi.fn((table: string) => {
  if (table === "devices") {
    devicesFromCalls += 1;
    if (devicesFromCalls === 1) {
      // First .from("devices") = the initial SELECT for fetch-by-id.
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => mockDeviceFetchSingle(),
          }),
        }),
      };
    }
    // Second .from("devices") = the compare-and-set UPDATE.
    return {
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              maybeSingle: () => mockDevicesUpdateSingle(),
            }),
          }),
        }),
      }),
    };
  }
  if (table === "edges") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => mockEdgeFetchSingle(),
        }),
      }),
    };
  }
  if (table === "household_devices") {
    return {
      // Two distinct chains:
      //   AC-CASCADE link check: select().eq().eq().maybeSingle()
      //   Linked-households loop: select().eq().returns()  (returns array)
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => mockHouseholdDevicesLinkSingle(),
          }),
          // For the loop fetch: chain ends at .eq() with .returns()
          returns: () => mockHouseholdDevicesAllForDevice(),
        }),
      }),
    };
  }
  if (table === "households") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => mockHouseholdsFetchSingle(),
        }),
      }),
    };
  }
  throw new Error(`Unexpected table: ${table}`);
});

const mockGetUser = vi.fn(async () => ({
  data: { user: { id: "user-1" } },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// ── Fixtures ────────────────────────────────────────────────────────────

const DEVICE_UUID = "660e8400-e29b-41d4-a716-446655440aaa";
const EDGE_UUID = "660e8400-e29b-41d4-a716-446655440bbb";
const MG_UUID = "660e8400-e29b-41d4-a716-446655440ccc";
const HH_UUID = "660e8400-e29b-41d4-a716-446655440ddd";
const BAD_ID = "not-a-uuid";

function makeRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/devices/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("PATCH /api/devices/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessMicrogridReturn = true;
    devicesFromCalls = 0;

    mockDeviceFetchSingle.mockReset().mockResolvedValue({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "consumption_meter",
        name: "meter3",
      },
      error: null,
    });
    mockEdgeFetchSingle.mockReset().mockResolvedValue({
      data: { id: EDGE_UUID, microgrid_id: MG_UUID },
      error: null,
    });
    // Default: no primary-meter link blocks reclassification.
    mockHouseholdDevicesLinkSingle.mockReset().mockResolvedValue({
      data: null,
      error: null,
    });
    mockHouseholdsFetchSingle.mockReset().mockResolvedValue({
      data: { id: HH_UUID, display_name: "Block A, Unit 1" },
      error: null,
    });
    mockDevicesUpdateSingle.mockReset().mockResolvedValue({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "other",
        name: "meter3",
        openems_component_id: "meter3",
      },
      error: null,
    });
    // Default: no extra households linked to this device (just the empty
    // list — drives the revalidate loop).
    mockHouseholdDevicesAllForDevice.mockReset().mockResolvedValue({
      data: [],
      error: null,
    });
  });

  it("400: invalid UUID in [id]", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makeRequest(BAD_ID, { name: "x" }), {
      params: Promise.resolve({ id: BAD_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("400: empty body → no_changes", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makeRequest(DEVICE_UUID, {}), {
      params: Promise.resolve({ id: DEVICE_UUID }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("no_changes");
  });

  it("400: extra field (openems_component_id) → unsupported_field", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { openems_component_id: "meter9" }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("unsupported_field");
    expect(json.error).toContain("openems_component_id");
  });

  it("400: edge_id field → unsupported_field", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { edge_id: EDGE_UUID }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("unsupported_field");
    expect(json.error).toContain("edge_id");
  });

  it("400: invalid device_type → invalid_device_type", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { device_type: "smart_fridge" }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("invalid_device_type");
  });

  it("400: whitespace-only name → name_required", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makeRequest(DEVICE_UUID, { name: "   " }), {
      params: Promise.resolve({ id: DEVICE_UUID }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("name_required");
  });

  it("404: device missing or RLS-hidden", async () => {
    mockDeviceFetchSingle.mockResolvedValueOnce({ data: null, error: null });
    const { PATCH } = await import("../route");
    const res = await PATCH(makeRequest(DEVICE_UUID, { name: "x" }), {
      params: Promise.resolve({ id: DEVICE_UUID }),
    });
    expect(res.status).toBe(404);
  });

  it("404: cross-org device for org_manager (RLS hides at SELECT, .maybeSingle() returns null)", async () => {
    // This is exactly the same shape as the missing-row case — RLS hides
    // the row from the SELECT, and the route's null-check fires the 404
    // path BEFORE the explicit currentUserCanAccessMicrogrid gate, so a
    // 403 never surfaces for cross-org access.
    mockDeviceFetchSingle.mockResolvedValueOnce({ data: null, error: null });
    // Even if the gate WOULD have returned false, we never get there.
    canAccessMicrogridReturn = false;
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { device_type: "pv_meter" }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(404);
  });

  it("200: happy path — device_type only", async () => {
    mockDevicesUpdateSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "pv_meter",
        name: "meter3",
        openems_component_id: "meter3",
      },
      error: null,
    });
    // Start state: device_type = pv_meter so reclassifying TO pv_meter
    // requires we change the seed to something else first. Simplify by
    // starting as "other" and reclassifying to "pv_meter" — neither
    // direction triggers AC-CASCADE.
    mockDeviceFetchSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "other",
        name: "meter3",
      },
      error: null,
    });

    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { device_type: "pv_meter" }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.device).toBeDefined();
    expect(json.device.device_type).toBe("pv_meter");
  });

  it("200: happy path — name only", async () => {
    mockDevicesUpdateSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "consumption_meter",
        name: "Renamed Meter",
        openems_component_id: "meter3",
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { name: "Renamed Meter" }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.device.name).toBe("Renamed Meter");
    // Name-only change does not flip type — AC-CASCADE must NOT trigger
    // (so no link probe fires).
    expect(mockHouseholdDevicesLinkSingle).not.toHaveBeenCalled();
  });

  it("200: happy path — both device_type and name", async () => {
    mockDeviceFetchSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "other",
        name: "meter3",
      },
      error: null,
    });
    mockDevicesUpdateSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "consumption_meter",
        name: "Block A Meter",
        openems_component_id: "meter3",
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, {
        device_type: "consumption_meter",
        name: "Block A Meter",
      }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.device.device_type).toBe("consumption_meter");
    expect(json.device.name).toBe("Block A Meter");
  });

  it("200: idempotent PATCH (supplied values equal current values)", async () => {
    // Fetched + supplied values match. The route still issues the UPDATE
    // (Supabase .update() is naturally idempotent). 200 with the row.
    mockDevicesUpdateSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "consumption_meter",
        name: "meter3",
        openems_component_id: "meter3",
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, {
        device_type: "consumption_meter",
        name: "meter3",
      }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(200);
    // No type change → no AC-CASCADE probe.
    expect(mockHouseholdDevicesLinkSingle).not.toHaveBeenCalled();
  });

  it("409: AC-CASCADE — consumption_meter with primary link → device_type_role_conflict", async () => {
    mockHouseholdDevicesLinkSingle.mockResolvedValueOnce({
      data: { household_id: HH_UUID },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { device_type: "other" }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_type_role_conflict");
    expect(json.household).toBeDefined();
    expect(json.household.id).toBe(HH_UUID);
    expect(json.household.display_name).toBe("Block A, Unit 1");
    // Conflict path short-circuits BEFORE the UPDATE.
    expect(mockDevicesUpdateSingle).not.toHaveBeenCalled();
  });

  it("409: race protection — UPDATE returns 0 rows → device_type_changed_concurrently", async () => {
    // No primary link blocks the change…
    mockHouseholdDevicesLinkSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    // …but a concurrent writer flipped device_type between SELECT and
    // UPDATE — the compare-and-set guard returns no row.
    mockDevicesUpdateSingle.mockResolvedValueOnce({ data: null, error: null });

    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { device_type: "other" }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_type_changed_concurrently");
  });

  it("200: reclassify a non-consumption_meter device with no primary link", async () => {
    mockDeviceFetchSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "other",
        name: "meter3",
      },
      error: null,
    });
    mockDevicesUpdateSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "pv_meter",
        name: "meter3",
        openems_component_id: "meter3",
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, { device_type: "pv_meter" }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(200);
    // Going FROM "other" → not consumption_meter → AC-CASCADE doesn't
    // probe (the guard only fires when going AWAY FROM consumption_meter).
    expect(mockHouseholdDevicesLinkSingle).not.toHaveBeenCalled();
  });

  it("200: reclassify consumption_meter → consumption_meter (no type change) does NOT trigger AC-CASCADE", async () => {
    mockDevicesUpdateSingle.mockResolvedValueOnce({
      data: {
        id: DEVICE_UUID,
        edge_id: EDGE_UUID,
        device_type: "consumption_meter",
        name: "meter3-renamed",
        openems_component_id: "meter3",
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makeRequest(DEVICE_UUID, {
        device_type: "consumption_meter",
        name: "meter3-renamed",
      }),
      { params: Promise.resolve({ id: DEVICE_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockHouseholdDevicesLinkSingle).not.toHaveBeenCalled();
  });
});
