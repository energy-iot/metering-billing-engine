/**
 * PATCH /api/microgrids/[id] — timezone write-path tests (#357).
 *
 * Covers:
 *   - 200: valid IANA zone persists (update payload carries timezone)
 *   - 200: 'UTC' accepted (literal id, not in Intl.supportedValuesOf)
 *   - 422: 'Kampala' (city, not a zone), '' (empty), 'UTC+3' (offset),
 *     'Mars/OlympusMons' — all rejected with field='timezone', and the
 *     update never reaches the database
 *   - 200: PATCH without a timezone key does not touch the column
 *   - 403: forbidden via currentUserCanAccessMicrogrid
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ───────────────────────────────────────────────────────────────

let canAccessMicrogridReturn = true;

// Captures the object passed to .update() so tests can assert exactly what
// would be written.
const mockUpdate = vi.fn();
const mockMaybeSingle = vi.fn();

const mockFrom = vi.fn((table: string) => {
  if (table === "microgrids") {
    return {
      update: (updates: Record<string, unknown>) => {
        mockUpdate(updates);
        return {
          eq: () => ({
            select: () => ({
              maybeSingle: () => mockMaybeSingle(),
            }),
          }),
        };
      },
    };
  }
  throw new Error(`Unexpected table: ${table}`);
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: "u1" } } })) },
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { PATCH } from "../route";

const MG_UUID = "770e8400-e29b-41d4-a716-446655440001";

function makePatch(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/microgrids/${MG_UUID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function callPatch(body: unknown) {
  return PATCH(makePatch(body), {
    params: Promise.resolve({ id: MG_UUID }),
  });
}

describe("PATCH /api/microgrids/[id] — timezone (#357)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessMicrogridReturn = true;
    mockMaybeSingle.mockResolvedValue({
      data: { id: MG_UUID, timezone: "Africa/Kampala" },
      error: null,
    });
  });

  it("accepts a valid IANA zone and includes it in the update", async () => {
    const res = await callPatch({ timezone: "Africa/Kampala" });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ timezone: "Africa/Kampala" });
  });

  it("accepts the literal 'UTC'", async () => {
    const res = await callPatch({ timezone: "UTC" });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ timezone: "UTC" });
  });

  it.each(["Kampala", "", "UTC+3", "Mars/OlympusMons"])(
    "rejects %j with 422 field='timezone' and never writes",
    async (bad) => {
      const res = await callPatch({ timezone: bad });
      expect(res.status).toBe(422);
      const body = (await res.json()) as { error: string; field: string };
      expect(body.field).toBe("timezone");
      expect(mockUpdate).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-string timezone (null) with 422", async () => {
    const res = await callPatch({ timezone: null });
    expect(res.status).toBe(422);
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("does not touch the timezone column when the key is absent", async () => {
    const res = await callPatch({ name: "Renamed MG" });
    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0][0]).not.toHaveProperty("timezone");
  });

  it("returns 403 when the caller cannot access the microgrid", async () => {
    canAccessMicrogridReturn = false;
    const res = await callPatch({ timezone: "Africa/Kampala" });
    expect(res.status).toBe(403);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
