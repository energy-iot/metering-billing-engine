/**
 * POST /api/microgrids & PATCH /api/microgrids/[id] — route tests (#76).
 *
 * All Supabase + auth helpers mocked. Covers:
 *   - POST: 422 invalid currency (Intl.NumberFormat RangeError)
 *   - POST: 409 duplicate microgrid name in same community (Postgres 23505)
 *   - POST: 403 when currentUserCanAccessCommunity returns false
 *   - PATCH: dirty-fields — sending {address_city} does NOT clobber name/currency
 *   - PATCH: 422 invalid currency on update
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ───────────────────────────────────────────────────────────────

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

let canAccessCommunityReturn = true;
let canAccessMicrogridReturn = true;

const mockInsert = vi.fn();
const mockUpdate = vi.fn();
const mockSingleAfterInsertSelect = vi.fn();
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
      eq: () => ({
        select: () => ({
          maybeSingle: () => mockMaybeSingleAfterUpdateSelect(),
        }),
      }),
    };
  },
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessCommunity: async () => canAccessCommunityReturn,
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

const VALID_COMMUNITY = "550e8400-e29b-41d4-a716-446655440000";
const VALID_MICROGRID = "550e8400-e29b-41d4-a716-446655440001";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/microgrids", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePatch(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/microgrids/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── POST tests ──────────────────────────────────────────────────────────

describe("POST /api/microgrids", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessCommunityReturn = true;
    canAccessMicrogridReturn = true;
    mockSingleAfterInsertSelect.mockReset();
  });

  it("returns 422 with field='currency' when currency is invalid", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "XXX_NOT_A_CODE",
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("currency");
  });

  it("returns 422 when currency is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
      })
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("currency");
  });

  it("returns 403 when currentUserCanAccessCommunity is false", async () => {
    canAccessCommunityReturn = false;
    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "UGX",
      })
    );
    expect(res.status).toBe(403);
  });

  it("returns 409 with the exact duplicate-name message on Postgres 23505", async () => {
    mockSingleAfterInsertSelect.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "microgrids_community_name_unique"',
      },
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "Kisakye MG-1",
        currency: "UGX",
      })
    );

    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe(
      "A microgrid named 'Kisakye MG-1' already exists in this community."
    );
    expect(json.field).toBe("name");
  });

  it("returns 201 with the inserted row on happy path", async () => {
    mockSingleAfterInsertSelect.mockResolvedValueOnce({
      data: { id: "m1", name: "New MG", currency: "USD" },
      error: null,
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePost({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "USD",
      })
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.microgrid.id).toBe("m1");

    // Verify currency was sent as uppercase ISO code
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        community_id: VALID_COMMUNITY,
        name: "New MG",
        currency: "USD",
      })
    );

    expect(mockRevalidatePath).toHaveBeenCalledWith("/microgrids", "layout");
    expect(mockRevalidatePath).toHaveBeenCalledWith(
      `/communities/${VALID_COMMUNITY}`,
      "layout"
    );
  });
});

// ── PATCH tests ─────────────────────────────────────────────────────────

describe("PATCH /api/microgrids/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessCommunityReturn = true;
    canAccessMicrogridReturn = true;
    mockMaybeSingleAfterUpdateSelect.mockReset();
  });

  it("dirty-fields: sending {address_city} does NOT clobber name/currency", async () => {
    mockMaybeSingleAfterUpdateSelect.mockResolvedValueOnce({
      data: {
        id: "m1",
        name: "Kisakye MG-1",
        currency: "UGX",
        address_city: "Entebbe",
      },
      error: null,
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatch(VALID_MICROGRID, { address_city: "Entebbe" }), {
      params: Promise.resolve({ id: VALID_MICROGRID }),
    });

    expect(res.status).toBe(200);
    // Supabase update() called with ONLY { address_city: 'Entebbe' } — NOT name, NOT currency
    expect(mockUpdate).toHaveBeenCalledWith({ address_city: "Entebbe" });
  });

  it("returns 422 when PATCH body has invalid currency", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_MICROGRID, { currency: "BOGUS" }),
      { params: Promise.resolve({ id: VALID_MICROGRID }) }
    );
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("currency");
  });

  it("returns 403 when currentUserCanAccessMicrogrid is false", async () => {
    canAccessMicrogridReturn = false;
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(makePatch(VALID_MICROGRID, { name: "X" }), {
      params: Promise.resolve({ id: VALID_MICROGRID }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 409 on rename collision with 23505 constraint", async () => {
    mockMaybeSingleAfterUpdateSelect.mockResolvedValueOnce({
      data: null,
      error: {
        code: "23505",
        message:
          'duplicate key value violates unique constraint "microgrids_community_name_unique"',
      },
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_MICROGRID, { name: "Kisakye MG-1" }),
      { params: Promise.resolve({ id: VALID_MICROGRID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toBe(
      "A microgrid named 'Kisakye MG-1' already exists in this community."
    );
  });
});
