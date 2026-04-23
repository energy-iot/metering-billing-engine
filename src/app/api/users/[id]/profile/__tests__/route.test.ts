/**
 * PATCH /api/users/[id]/profile — route handler unit tests (#96).
 *
 * Supabase I/O and auth are mocked. Covers:
 *   - Case 1: self-edit PATCH with a trigger-backfilled (empty) profile row → 200
 *   - Case 2: missing profile row (trigger failure / data integrity gap) → 500
 *   - Case 3: cross-user attempt (RLS block, code 42501) → 403
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ───────────────────────────────────────────────────────────────────

// Mutable return values — each test overrides as needed.
let mockUpdateReturn: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

// Chain: supabase.from("user_profiles").update(…).eq(…).select("*")
const mockSelect = vi.fn(() => Promise.resolve(mockUpdateReturn));
const mockEq = vi.fn(() => ({ select: mockSelect }));
const mockUpdate = vi.fn(() => ({ eq: mockEq }));
const mockFrom = vi.fn(() => ({ update: mockUpdate }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

const SELF_UUID = "550e8400-e29b-41d4-a716-446655440001";
const OTHER_UUID = "550e8400-e29b-41d4-a716-446655440002";

function makePatchRequest(
  id: string,
  body: Record<string, unknown>
): NextRequest {
  return new NextRequest(`http://localhost/api/users/${id}/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PATCH /api/users/[id]/profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdateReturn = { data: null, error: null };
  });

  // ── Case 1: happy path ───────────────────────────────────────────────────
  // Migration 00017 guarantees a profile row exists (trigger + backfill).
  // The returned row may have NULL first_name/last_name/phone if it was
  // created by the trigger before the invite RPC overwrote it, or may have
  // real values if the PATCH just wrote them. Either way the route returns
  // the full row from the .select("*").
  it("returns 200 with updated profile on self-edit (trigger-backfilled row)", async () => {
    mockUpdateReturn = {
      data: [
        {
          user_id: SELF_UUID,
          first_name: "Alejandro",
          last_name: "Malbet",
          phone: null,
          created_at: "2026-04-23T00:00:00Z",
          updated_at: "2026-04-23T00:00:01Z",
        },
      ],
      error: null,
    };

    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(SELF_UUID, { first_name: "Alejandro", last_name: "Malbet" }), {
      params: Promise.resolve({ id: SELF_UUID }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.profile.first_name).toBe("Alejandro");
    expect(json.profile.last_name).toBe("Malbet");
    expect(json.profile.user_id).toBe(SELF_UUID);

    // Confirm the correct table and filter were used.
    expect(mockFrom).toHaveBeenCalledWith("user_profiles");
    expect(mockUpdate).toHaveBeenCalledWith({ first_name: "Alejandro", last_name: "Malbet" });
    expect(mockEq).toHaveBeenCalledWith("user_id", SELF_UUID);
  });

  // ── Case 2: missing profile row (should not happen post-00017) ───────────
  // If the trigger somehow failed and no profile row exists, the UPDATE
  // returns data: [] (empty array — RLS filters the row out OR the row does
  // not exist). Post-00017, this represents a real bug: return 500.
  it("returns 500 when profile row is missing (data integrity gap)", async () => {
    mockUpdateReturn = { data: [], error: null };

    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(SELF_UUID, { first_name: "X" }), {
      params: Promise.resolve({ id: SELF_UUID }),
    });

    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toMatch(/internal error/i);
  });

  // ── Case 3: cross-user attempt blocked by RLS ────────────────────────────
  // Supabase returns a postgres error with code 42501 (insufficient privilege)
  // when RLS blocks the operation at the policy level. The route converts
  // this to a 403.
  it("returns 403 when RLS blocks update of another user's profile (code 42501)", async () => {
    mockUpdateReturn = {
      data: null,
      error: {
        code: "42501",
        message: "new row violates row-level security policy for table \"user_profiles\"",
      },
    };

    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(OTHER_UUID, { first_name: "Hacker" }), {
      params: Promise.resolve({ id: OTHER_UUID }),
    });

    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Not authorized to update this profile.");
  });

  // ── Edge: 400 for malformed UUID ─────────────────────────────────────────
  it("returns 400 for a malformed UUID in the path", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      new NextRequest("http://localhost/api/users/not-a-uuid/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: "X" }),
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    expect(res.status).toBe(400);
  });

  // ── Edge: 422 when no updatable fields in body ───────────────────────────
  it("returns 422 when the body contains no updatable fields", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(SELF_UUID, { unrelated_field: "ignored" }), {
      params: Promise.resolve({ id: SELF_UUID }),
    });
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/no updatable fields/i);
  });
});
