/**
 * PATCH /api/households/[id] — route tests (#145).
 *
 * Covers:
 *   - 400: bad UUID, invalid JSON, empty diff, unsupported field, invalid display_name
 *   - 200: happy path (display_name only, no device touch)
 *   - 200: happy path (device_id link via delete-then-insert)
 *   - 200: happy path (device_id: null → unlink only, no field update)
 *   - 403: forbidden via currentUserCanAccessMicrogrid
 *   - 404: not found (household missing or RLS-hidden)
 *   - 409: device_id partial-unique-index conflict (23505)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ───────────────────────────────────────────────────────────────

let canAccessMicrogridReturn = true;

// Per-test handlers for each Supabase chain entry-point. Chain-callability is
// emulated via thenable chains that return a fresh stub per entry.
const mockHouseholdsFetchSingle = vi.fn();
const mockHouseholdsUpdateSingle = vi.fn();
const mockHouseholdsRefetchSingle = vi.fn();
const mockHouseholdDevicesDeleteEq2 = vi.fn();
const mockHouseholdDevicesInsert = vi.fn();
// Steal-check: SELECT household_id FROM household_devices WHERE device_id=? AND role=? AND household_id != ?
const mockHouseholdDevicesStealCheckMaybeSingle = vi.fn();

// Track call counts to dispatch successive .from("households") calls.
let householdsCalls = 0;

const mockFrom = vi.fn((table: string) => {
  if (table === "households") {
    householdsCalls += 1;
    if (householdsCalls === 1) {
      // Initial fetch: select(...).eq(...).maybeSingle()
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => mockHouseholdsFetchSingle(),
          }),
        }),
      };
    }
    if (householdsCalls === 2) {
      // The update or refetch path. Detect by what's called first.
      return {
        update: () => ({
          eq: () => ({
            select: () => ({
              single: () => mockHouseholdsUpdateSingle(),
            }),
          }),
        }),
        select: () => ({
          eq: () => ({
            single: () => mockHouseholdsRefetchSingle(),
          }),
        }),
      };
    }
    // 3rd+ call → refetch after device-only update
    return {
      select: () => ({
        eq: () => ({
          single: () => mockHouseholdsRefetchSingle(),
        }),
      }),
    };
  }
  if (table === "household_devices") {
    return {
      // Steal-check path: select().eq().eq().neq().maybeSingle()
      select: () => ({
        eq: () => ({
          eq: () => ({
            neq: () => ({
              maybeSingle: () => mockHouseholdDevicesStealCheckMaybeSingle(),
            }),
          }),
        }),
      }),
      delete: () => ({
        eq: () => ({
          eq: () => mockHouseholdDevicesDeleteEq2(),
        }),
      }),
      insert: (row: unknown) => mockHouseholdDevicesInsert(row),
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

const HH_UUID = "660e8400-e29b-41d4-a716-446655440001";
const HH_UUID_B = "660e8400-e29b-41d4-a716-446655440002";
const MG_UUID = "660e8400-e29b-41d4-a716-446655440099";
const DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544aaaa";
const BAD_ID = "not-a-uuid";

function makePatchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/households/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /api/households/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessMicrogridReturn = true;
    householdsCalls = 0;

    mockHouseholdsFetchSingle.mockReset().mockResolvedValue({
      data: { id: HH_UUID, microgrid_id: MG_UUID },
      error: null,
    });
    mockHouseholdsUpdateSingle.mockReset().mockResolvedValue({
      data: {
        id: HH_UUID,
        microgrid_id: MG_UUID,
        display_name: "Updated",
        primary_email: null,
        primary_phone: null,
        address_line1: null,
        address_line2: null,
        unit_label: null,
      },
      error: null,
    });
    mockHouseholdsRefetchSingle.mockReset().mockResolvedValue({
      data: {
        id: HH_UUID,
        microgrid_id: MG_UUID,
        display_name: "Existing",
        primary_email: null,
        primary_phone: null,
        address_line1: null,
        address_line2: null,
        unit_label: null,
      },
      error: null,
    });
    mockHouseholdDevicesDeleteEq2.mockReset().mockResolvedValue({
      error: null,
    });
    mockHouseholdDevicesInsert.mockReset().mockResolvedValue({
      error: null,
    });
    // Default: no existing cross-household link (steal check passes)
    mockHouseholdDevicesStealCheckMaybeSingle.mockReset().mockResolvedValue({
      data: null,
      error: null,
    });
  });

  it("400: bad UUID", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(BAD_ID, { display_name: "x" }), {
      params: Promise.resolve({ id: BAD_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("400: invalid JSON", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(HH_UUID, "{not json"), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(400);
  });

  it("400: empty diff", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(HH_UUID, {}), {
      params: Promise.resolve({ id: HH_UUID }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("empty_diff");
  });

  it("400: unsupported field rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { microgrid_id: "x" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Unsupported field: microgrid_id");
    expect(json.reason).toBe("unsupported_field");
  });

  it("400: empty display_name rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "   " }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("invalid_display_name");
  });

  it("400: non-UUID device_id rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: "not-a-uuid" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("invalid_device_id");
  });

  it("200: happy path — display_name only", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "New Name" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.household).toBeDefined();
    expect(mockHouseholdsUpdateSingle).toHaveBeenCalledTimes(1);
    expect(mockHouseholdDevicesDeleteEq2).not.toHaveBeenCalled();
    expect(mockHouseholdDevicesInsert).not.toHaveBeenCalled();
  });

  it("200: happy path — device link (delete-then-insert)", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockHouseholdDevicesDeleteEq2).toHaveBeenCalledTimes(1);
    expect(mockHouseholdDevicesInsert).toHaveBeenCalledTimes(1);
    expect(mockHouseholdDevicesInsert).toHaveBeenCalledWith({
      household_id: HH_UUID,
      device_id: DEVICE_UUID,
      role: "primary_consumption_meter",
    });
  });

  it("200: happy path — device unlink (device_id: null) → delete only, no insert, no household update", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: null }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(200);
    expect(mockHouseholdDevicesDeleteEq2).toHaveBeenCalledTimes(1);
    expect(mockHouseholdDevicesInsert).not.toHaveBeenCalled();
    // No household-field update — refetch path
    expect(mockHouseholdsUpdateSingle).not.toHaveBeenCalled();
    expect(mockHouseholdsRefetchSingle).toHaveBeenCalledTimes(1);
  });

  it("403: currentUserCanAccessMicrogrid returns false", async () => {
    canAccessMicrogridReturn = false;
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "x" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("forbidden");
  });

  it("404: household not found", async () => {
    mockHouseholdsFetchSingle.mockResolvedValueOnce({
      data: null,
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "x" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(404);
  });

  it("409: device link conflict (Postgres 23505)", async () => {
    mockHouseholdDevicesInsert.mockResolvedValueOnce({
      error: { code: "23505", message: "duplicate key value violates unique constraint" },
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_already_linked");
  });

  it("409: cross-household device steal blocked before any mutation", async () => {
    // Pre-seed: DEVICE_UUID is already the primary_consumption_meter for HH_UUID_B.
    // Household A (HH_UUID) attempts to claim it.
    mockHouseholdDevicesStealCheckMaybeSingle.mockResolvedValueOnce({
      data: { household_id: HH_UUID_B },
      error: null,
    });

    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { device_id: DEVICE_UUID }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );

    // Should be rejected with 409 device_already_linked
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_already_linked");
    expect(json.error).toMatch(/already linked to another household/);

    // Steal check fires BEFORE any mutation — no household-row update,
    // no delete, no insert on household_devices.
    expect(mockHouseholdsUpdateSingle).not.toHaveBeenCalled();
    expect(mockHouseholdDevicesDeleteEq2).not.toHaveBeenCalled();
    expect(mockHouseholdDevicesInsert).not.toHaveBeenCalled();
  });

  it("403: RLS denial (42501) on household update", async () => {
    mockHouseholdsUpdateSingle.mockResolvedValueOnce({
      data: null,
      error: {
        code: "42501",
        message: "new row violates row-level security policy for table households",
      },
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(HH_UUID, { display_name: "x" }),
      { params: Promise.resolve({ id: HH_UUID }) }
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.reason).toBe("rls_denied");
  });
});
