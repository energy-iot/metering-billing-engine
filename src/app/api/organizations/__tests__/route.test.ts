/**
 * POST /api/organizations & PATCH /api/organizations/[id] — route tests (#76).
 *
 * All Supabase I/O + auth are mocked. Covers:
 *   - POST: 422 missing address_city / address_country
 *   - POST: 403 when not super_admin
 *   - POST: 201 happy path
 *   - PATCH: dirty-fields — sending {address_city} does NOT clobber name
 *   - PATCH: 422 when clearing required address_city
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ───────────────────────────────────────────────────────────────

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

let isSuperAdminReturn = true;
const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockSelectAfterInsert = vi.fn();
const mockSingleAfterInsertSelect = vi.fn();

const mockEqUpdate = vi.fn();
const mockSelectAfterUpdate = vi.fn();
const mockMaybeSingleAfterUpdateSelect = vi.fn();

const mockFrom = vi.fn(() => ({
  insert: (row: unknown) => {
    mockInsert(row);
    return {
      select: () => ({
        single: () => mockSingleAfterInsertSelect(),
      }),
    };
  },
  update: (patch: unknown) => {
    mockUpdate(patch);
    return {
      eq: (col: string, val: string) => {
        mockEqUpdate(col, val);
        return {
          select: () => ({
            maybeSingle: () => mockMaybeSingleAfterUpdateSelect(),
          }),
        };
      },
    };
  },
}));

void mockSelectAfterInsert;
void mockSelectAfterUpdate;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserIsSuperAdmin: async () => isSuperAdminReturn,
}));

function makeRequest(body: unknown, method = "POST"): NextRequest {
  return new NextRequest("http://localhost/api/organizations", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("POST /api/organizations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSuperAdminReturn = true;
    mockSingleAfterInsertSelect.mockReset();
  });

  it("returns 403 when the caller is not a super_admin", async () => {
    isSuperAdminReturn = false;
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        name: "NFE",
        address_city: "Kampala",
        address_country: "Uganda",
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 422 with field='address_city' when city is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        name: "NFE",
        address_country: "Uganda",
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("address_city");
  });

  it("returns 422 with field='address_country' when country is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        name: "NFE",
        address_city: "Kampala",
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("address_country");
  });

  it("returns 422 with field='name' when name is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        address_city: "Kampala",
        address_country: "Uganda",
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("name");
  });

  it("returns 201 with the inserted row on happy path", async () => {
    mockSingleAfterInsertSelect.mockResolvedValueOnce({
      data: { id: "o1", name: "NFE" },
      error: null,
    });

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({
        name: "NFE",
        address_city: "Kampala",
        address_country: "Uganda",
      })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.organization.id).toBe("o1");

    expect(mockRevalidatePath).toHaveBeenCalledWith("/organizations", "layout");
  });
});

describe("PATCH /api/organizations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSuperAdminReturn = true;
    mockMaybeSingleAfterUpdateSelect.mockReset();
  });

  it("sends ONLY dirty fields to Supabase (does not clobber untouched name)", async () => {
    mockMaybeSingleAfterUpdateSelect.mockResolvedValueOnce({
      data: { id: "o1", name: "NFE", address_city: "Entebbe" },
      error: null,
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/organizations/${VALID_UUID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address_city: "Entebbe" }),
      }),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );

    expect(res.status).toBe(200);
    // Supabase update() called with ONLY { address_city } — NOT name, country, etc.
    expect(mockUpdate).toHaveBeenCalledWith({ address_city: "Entebbe" });
  });

  it("returns 422 when PATCH attempts to clear required address_city", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/organizations/${VALID_UUID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address_city: "" }),
      }),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("address_city");
  });

  it("returns 400 for malformed UUID", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/organizations/not-a-uuid`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "X" }),
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );

    expect(res.status).toBe(400);
  });

  it("returns 403 when caller is not super_admin", async () => {
    isSuperAdminReturn = false;
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/organizations/${VALID_UUID}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Update" }),
      }),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );

    expect(res.status).toBe(403);
  });
});
