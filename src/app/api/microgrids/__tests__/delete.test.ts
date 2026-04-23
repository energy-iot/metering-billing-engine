/**
 * DELETE /api/microgrids/[id] + GET delete-preview route tests (#89).
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
  currentUserCanAccessMicrogrid: async () => canAccessReturn,
  currentUserCanAccessCommunity: async () => canAccessReturn,
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
  data: { id: string; name: string; community_id: string } | null;
  error: { code?: string; message: string } | null;
}) {
  mockFromImpl.mockImplementation((table: string) => {
    if (table === "microgrids") {
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
  return new NextRequest(`http://localhost/api/microgrids/${id}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/microgrids/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
    getUserReturn = { user: { id: "user-1" } };
  });

  it("400 malformed UUID", async () => {
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete("bad"), {
      params: Promise.resolve({ id: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("403 when caller cannot access microgrid", async () => {
    canAccessReturn = false;
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(403);
  });

  it("404 when microgrid not found", async () => {
    configureEntityLookup({ data: null, error: null });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
  });

  it("204 happy path + fn_entity_delete_microgrid dispatch", async () => {
    configureEntityLookup({
      data: {
        id: VALID_UUID,
        name: "Kisakye Main",
        community_id: "comm-1",
      },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(204);
    expect(mockRpcImpl).toHaveBeenCalledWith("fn_entity_delete_microgrid", {
      p_id: VALID_UUID,
    });
    infoSpy.mockRestore();
  });
});

describe("GET /api/microgrids/[id]/delete-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
  });

  it("200 happy path — parent = { kind:'community', id:<community_id> }", async () => {
    configureEntityLookup({
      data: {
        id: VALID_UUID,
        name: "Kisakye Main",
        community_id: "comm-1",
      },
      error: null,
    });

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/microgrids/${VALID_UUID}/delete-preview`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.descendant_counts.kind).toBe("microgrid");
    expect(json.parent).toEqual({ kind: "community", id: "comm-1" });
  });
});
