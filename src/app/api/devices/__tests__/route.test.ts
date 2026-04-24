/**
 * POST /api/devices — unit tests (F #67)
 *
 * All Supabase I/O is mocked — no real DB hits.
 *
 * Cases:
 *   (a) Missing edgeId → 400 "Request body must include edgeId and devices"
 *   (b) Non-UUID edgeId ("edge0") → 400 "Invalid edgeId — expected UUID."
 *   (c) Valid UUID + devices not an array → 400 "devices must be a non-empty array"
 *   (d) Valid UUID + empty devices array → 400 "devices must be a non-empty array"
 *   (e) Valid UUID + valid device row → 200 { saved: [...] }
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Supabase mock ────────────────────────────────────────────────────────────

const mockSelect = vi.fn();
const mockUpsert = vi.fn(() => ({ select: mockSelect }));
const mockFrom = vi.fn(() => ({ upsert: mockUpsert }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

// ─── Helper ───────────────────────────────────────────────────────────────────

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/devices", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

const VALID_DEVICE = {
  componentId: "meter0",
  deviceType: "consumption_meter",
  name: "Main Meter",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/devices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Missing edgeId field → 400 with presence-check message
  it("(a) returns 400 when edgeId is missing", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ devices: [VALID_DEVICE] });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Request body must include edgeId and devices");
  });

  // (b) Non-UUID edgeId → 400 with UUID error message
  it("(b) returns 400 when edgeId is not a UUID", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ edgeId: "edge0", devices: [VALID_DEVICE] });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid edgeId — expected UUID.");
  });

  // (c) Valid UUID + devices not an array → 400
  it("(c) returns 400 when devices is not an array", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ edgeId: VALID_UUID, devices: "not-an-array" });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("devices must be a non-empty array");
  });

  // (d) Valid UUID + empty devices array → 400 (preserves current behavior)
  it("(d) returns 400 when devices is an empty array", async () => {
    const { POST } = await import("../route");
    const req = makeRequest({ edgeId: VALID_UUID, devices: [] });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("devices must be a non-empty array");
  });

  // (e) Valid UUID + valid device row → 200 with saved rows
  it("(e) returns 200 with saved rows for valid payload", async () => {
    const savedRow = {
      id: "device-uuid-1",
      name: "Main Meter",
      device_type: "consumption_meter",
      openems_component_id: "meter0",
    };

    mockSelect.mockResolvedValueOnce({ data: [savedRow], error: null });

    const { POST } = await import("../route");
    const req = makeRequest({
      edgeId: VALID_UUID,
      devices: [VALID_DEVICE],
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ saved: [savedRow] });

    // Verify Supabase was called with snake_case mapped rows
    expect(mockFrom).toHaveBeenCalledWith("devices");
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          edge_id: VALID_UUID,
          openems_component_id: "meter0",
          device_type: "consumption_meter",
          name: "Main Meter",
        }),
      ]),
      expect.objectContaining({ onConflict: "edge_id,openems_component_id" })
    );
  });

  // (f) openemsChannelAddress: null is accepted — non-billable devices registered for observability
  it("(f) returns 200 when openemsChannelAddress is null (non-billable device)", async () => {
    const savedRow = {
      id: "device-uuid-2",
      name: "Main Battery",
      device_type: "battery",
      openems_component_id: "ess0",
    };

    mockSelect.mockResolvedValueOnce({ data: [savedRow], error: null });

    const { POST } = await import("../route");
    const req = makeRequest({
      edgeId: VALID_UUID,
      devices: [
        {
          componentId: "ess0",
          factoryId: "io.openems.edge.ess.generic.ManagedSymmetricEss",
          openemsChannelAddress: null,
          deviceType: "battery",
          name: "Main Battery",
        },
      ],
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ saved: [savedRow] });
  });
});
