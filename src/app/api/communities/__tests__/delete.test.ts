/**
 * DELETE /api/communities/[id] + GET delete-preview route tests (#89).
 *
 * Covers: 400 invalid UUID, 403 unauthorized, 404 not found, 204 happy.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let canAccessReturn = true;
let getUserReturn: { user: { id: string } | null } = {
  user: { id: "user-1" },
};

const mockFromImpl = vi.fn();
const mockRpcImpl = vi.fn();
const mockSupabaseClient = {
  from: (...args: unknown[]) => mockFromImpl(...args),
  rpc: (...args: unknown[]) => mockRpcImpl(...args),
  auth: { getUser: async () => ({ data: getUserReturn }) },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockSupabaseClient,
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessCommunity: async () => canAccessReturn,
  currentUserCanAccessMicrogrid: async () => canAccessReturn,
  currentUserIsSuperAdmin: async () => canAccessReturn,
  getCurrentUserRoles: async () =>
    canAccessReturn
      ? [{ role: "org_manager", scope_type: "org", scope_id: "org-1" }]
      : [],
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

function chainable(result: { data: unknown; error: unknown; count?: number }) {
  const stub: {
    eq: (...args: unknown[]) => typeof stub;
    in: (...args: unknown[]) => typeof stub;
    maybeSingle: () => Promise<unknown>;
    then: (onFulfilled: (v: unknown) => unknown) => Promise<unknown>;
  } = {
    eq: () => stub,
    in: () => stub,
    maybeSingle: () => Promise.resolve(result),
    then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
  };
  return stub;
}

function configureEntityLookup(result: {
  data: { id: string; name: string; org_id: string } | null;
  error: { code?: string; message: string } | null;
}) {
  mockFromImpl.mockImplementation((table: string) => {
    if (table === "communities") {
      return {
        select: () => ({
          eq: () => ({ maybeSingle: async () => result }),
        }),
      };
    }
    return {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) =>
        opts?.head
          ? chainable({ data: null, error: null, count: 0 })
          : chainable({ data: [], error: null }),
    };
  });
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function makeDelete(id: string): NextRequest {
  return new NextRequest(`http://localhost/api/communities/${id}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/communities/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
    getUserReturn = { user: { id: "user-1" } };
  });

  it("400 on malformed UUID", async () => {
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete("bogus"), {
      params: Promise.resolve({ id: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("403 when caller cannot access community", async () => {
    canAccessReturn = false;
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(403);
  });

  it("404 when community does not exist", async () => {
    configureEntityLookup({ data: null, error: null });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
  });

  it("204 happy path + rpc dispatched to fn_entity_delete_community", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "Kisakye", org_id: "org-1" },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(204);
    expect(mockRpcImpl).toHaveBeenCalledWith("fn_entity_delete_community", {
      p_id: VALID_UUID,
    });
    infoSpy.mockRestore();
  });
});

describe("GET /api/communities/[id]/delete-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
  });

  it("200 happy path returns { entity, descendant_counts, as_of, parent }", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "Kisakye", org_id: "org-1" },
      error: null,
    });

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/communities/${VALID_UUID}/delete-preview`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entity.id).toBe(VALID_UUID);
    expect(json.descendant_counts.kind).toBe("community");
    expect(typeof json.as_of).toBe("string");
    // Parent resolves to organization for a community.
    expect(json.parent).toEqual({ kind: "organization", id: "org-1" });
  });
});
