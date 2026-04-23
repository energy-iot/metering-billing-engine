/**
 * POST /api/communities & PATCH /api/communities/[id] — route tests (#76).
 *
 * Covers:
 *   - POST: 403 when org_id is outside the caller's accessible orgs
 *   - POST: 400 on malformed org_id
 *   - POST: 422 on missing name
 *   - PATCH: dirty-fields (address_city only → no name/geography_notes sent)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let canAccessOrgReturn = true;
let canAccessCommunityReturn = true;

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
  currentUserCanAccessOrg: async () => canAccessOrgReturn,
  currentUserCanAccessCommunity: async () => canAccessCommunityReturn,
}));

const VALID_ORG = "550e8400-e29b-41d4-a716-446655440000";
const VALID_COMMUNITY = "550e8400-e29b-41d4-a716-446655440010";

function makePost(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/communities", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePatch(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/communities/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── POST tests ──────────────────────────────────────────────────────────

describe("POST /api/communities", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrgReturn = true;
    canAccessCommunityReturn = true;
    mockSingleAfterInsertSelect.mockReset();
  });

  it("returns 400 when org_id is not a UUID", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ org_id: "not-a-uuid", name: "C1" })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.field).toBe("org_id");
  });

  it("returns 422 on missing name", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePost({ org_id: VALID_ORG }));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.field).toBe("name");
  });

  it("returns 403 when currentUserCanAccessOrg is false (cross-org)", async () => {
    canAccessOrgReturn = false;
    const { POST } = await import("../route");
    const res = await POST(
      makePost({ org_id: VALID_ORG, name: "Unauthorized C" })
    );
    expect(res.status).toBe(403);
  });

  it("returns 201 with the inserted row on happy path", async () => {
    mockSingleAfterInsertSelect.mockResolvedValueOnce({
      data: { id: "c1", name: "C1", org_id: VALID_ORG },
      error: null,
    });

    const { POST } = await import("../route");
    const res = await POST(makePost({ org_id: VALID_ORG, name: "C1" }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.community.id).toBe("c1");

    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ org_id: VALID_ORG, name: "C1" })
    );
  });
});

// ── PATCH tests ─────────────────────────────────────────────────────────

describe("PATCH /api/communities/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessCommunityReturn = true;
    mockMaybeSingleAfterUpdateSelect.mockReset();
  });

  it("dirty-fields: only {address_city} sent when only city changed", async () => {
    mockMaybeSingleAfterUpdateSelect.mockResolvedValueOnce({
      data: {
        id: VALID_COMMUNITY,
        name: "Kisakye",
        address_city: "Entebbe",
        geography_notes: null,
      },
      error: null,
    });

    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_COMMUNITY, { address_city: "Entebbe" }),
      { params: Promise.resolve({ id: VALID_COMMUNITY }) }
    );

    expect(res.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith({ address_city: "Entebbe" });
  });

  it("returns 403 when the caller cannot access the community", async () => {
    canAccessCommunityReturn = false;
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_COMMUNITY, { name: "X" }),
      { params: Promise.resolve({ id: VALID_COMMUNITY }) }
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when no fields to update", async () => {
    const { PATCH } = await import("../[id]/route");
    const res = await PATCH(
      makePatch(VALID_COMMUNITY, {}),
      { params: Promise.resolve({ id: VALID_COMMUNITY }) }
    );
    expect(res.status).toBe(400);
  });
});
