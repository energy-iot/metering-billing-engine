/**
 * DELETE /api/edges/[id] + GET delete-preview route tests (#89).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let canAccessReturn = true;
let isSuperAdminReturn = true;
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
  currentUserIsSuperAdmin: async () => isSuperAdminReturn,
  getCurrentUserRoles: async () =>
    isSuperAdminReturn
      ? [{ role: "super_admin", scope_type: "org", scope_id: "org-1" }]
      : canAccessReturn
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

function configureEdgeLookup(result: {
  data:
    | { id: string; name: string; microgrid_id: string }
    | null;
  error: { code?: string; message: string } | null;
}) {
  mockFromImpl.mockImplementation((table: string) => {
    if (table === "edges") {
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
  return new NextRequest(`http://localhost/api/edges/${id}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/edges/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
    isSuperAdminReturn = true;
    getUserReturn = { user: { id: "user-1" } };
  });

  it("400 malformed UUID", async () => {
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete("bad"), {
      params: Promise.resolve({ id: "bad" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when edge not found", async () => {
    configureEdgeLookup({ data: null, error: null });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when caller cannot access the parent microgrid", async () => {
    canAccessReturn = false;
    configureEdgeLookup({
      data: { id: VALID_UUID, name: "Edge-1", microgrid_id: "mg-1" },
      error: null,
    });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(403);
  });

  it("204 happy path + fn_entity_delete_edge dispatch + log emission", async () => {
    configureEdgeLookup({
      data: { id: VALID_UUID, name: "Edge-1", microgrid_id: "mg-1" },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(204);
    expect(mockRpcImpl).toHaveBeenCalledWith("fn_entity_delete_edge", {
      p_id: VALID_UUID,
    });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(logged.entity_kind).toBe("edge");
    expect(logged.descendant_counts.kind).toBe("edge");
    // AC-FK-AUDIT: edge counts use `billing_line_items_nulled`, not the
    // generic `billing_line_items` key.
    expect(logged.descendant_counts).toHaveProperty("billing_line_items_nulled");
    infoSpy.mockRestore();
  });

  it("204 org_manager happy path — actor_role logged as org_manager (Nit #6)", async () => {
    // Super admin is NOT the caller; org_manager has access via canAccess.
    isSuperAdminReturn = false;
    canAccessReturn = true;
    configureEdgeLookup({
      data: { id: VALID_UUID, name: "Edge-1", microgrid_id: "mg-1" },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeDelete(VALID_UUID), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(204);
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(logged.actor_role).toBe("org_manager");
    infoSpy.mockRestore();
  });
});

describe("GET /api/edges/[id]/delete-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessReturn = true;
    isSuperAdminReturn = true;
  });

  it("404 when edge does not exist (not 403) — Nit #3", async () => {
    // Edge not found — configureEdgeLookup returns null so the route must
    // return 404 before reaching the permission check.
    configureEdgeLookup({ data: null, error: null });

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/edges/${VALID_UUID}/delete-preview`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(404);
  });

  it("200 happy path — parent = { kind:'microgrid', id:<microgrid_id> }", async () => {
    configureEdgeLookup({
      data: { id: VALID_UUID, name: "Edge-1", microgrid_id: "mg-1" },
      error: null,
    });

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/edges/${VALID_UUID}/delete-preview`),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.descendant_counts.kind).toBe("edge");
    expect(json.parent).toEqual({ kind: "microgrid", id: "mg-1" });
  });
});
