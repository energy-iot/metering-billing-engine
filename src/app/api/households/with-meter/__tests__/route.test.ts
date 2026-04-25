/**
 * POST /api/households/with-meter — route tests (#155).
 *
 * Coverage focus: phone-required validation. The route validates phone
 * BEFORE calling the RPC (defense-in-depth) so non-form callers (bulk
 * imports, scripts) get a structured 400 without a DB round-trip.
 *
 * Covers:
 *   - 400: missing primary_phone (key absent)
 *   - 400: empty primary_phone ("")
 *   - 400: whitespace primary_phone ("   ")
 *   - 400: null primary_phone
 *   - 400: invalid JSON
 *   - 422: missing microgrid_id / display_name / device_id
 *   - 201: happy path with valid phone
 *   - 400: RPC raises 'household_phone_required' (defense-in-depth path)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ───────────────────────────────────────────────────────────────

const mockRpc = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    rpc: (...args: unknown[]) => mockRpc(...args),
  }),
}));

const MG_UUID = "660e8400-e29b-41d4-a716-446655440000";
const DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544aaaa";
const NEW_HH_UUID = "660e8400-e29b-41d4-a716-446655440111";

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/households/with-meter", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_BODY = {
  microgrid_id: MG_UUID,
  display_name: "Block A, Unit 1",
  device_id: DEVICE_UUID,
  primary_phone: "+256700000000",
};

describe("POST /api/households/with-meter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: NEW_HH_UUID, error: null });
  });

  it("400: invalid JSON", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest("{not json"));
    expect(res.status).toBe(400);
  });

  it("422: missing microgrid_id", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, microgrid_id: "" })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("microgrid_id");
  });

  it("422: missing display_name", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, display_name: "" })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("display_name");
  });

  it("422: missing device_id", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, device_id: "" })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("device_id");
  });

  it("400: #155 — primary_phone key missing returns household_phone_required", async () => {
    const { POST } = await import("../route");
    const { primary_phone: _phone, ...withoutPhone } = VALID_BODY;
    void _phone;
    const res = await POST(makePostRequest(withoutPhone));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(json.field).toBe("primary_phone");
    // No DB round-trip
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400: #155 — empty primary_phone returns household_phone_required", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, primary_phone: "" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400: #155 — whitespace primary_phone returns household_phone_required", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, primary_phone: "   " })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("400: #155 — null primary_phone returns household_phone_required", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ ...VALID_BODY, primary_phone: null })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("201: happy path with valid phone", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_BODY));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.household_id).toBe(NEW_HH_UUID);
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fnName, args] = mockRpc.mock.calls[0];
    expect(fnName).toBe("fn_create_household_with_meter");
    expect((args as Record<string, unknown>).p_primary_phone).toBe(
      "+256700000000"
    );
  });

  it("400: #155 — RPC raises household_phone_required → 400 (defense-in-depth)", async () => {
    // Should be unreachable in practice (route guards first) but this path
    // protects against direct RPC callers if anyone bypasses the route.
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { code: "P0001", message: "household_phone_required" },
    });
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(VALID_BODY));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("household_phone_required");
  });
});
