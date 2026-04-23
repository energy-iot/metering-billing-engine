/**
 * DELETE /api/organizations/[id] + GET delete-preview route tests (#89).
 *
 * Supabase I/O + auth helpers are mocked. Covers:
 *   - DELETE: 400 invalid UUID
 *   - DELETE: 403 unauthorized (not super_admin)
 *   - DELETE: 404 entity not found
 *   - DELETE: 204 happy path + asserts the structured log payload shape
 *   - Preview: 200 happy path returns { entity, descendant_counts, as_of, parent }
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ───────────────────────────────────────────────────────────────

let isSuperAdminReturn = true;
let getUserReturn: { user: { id: string } | null } = {
  user: { id: "user-1" },
};

const mockFromImpl = vi.fn();
const mockRpcImpl = vi.fn();

const mockSupabaseClient = {
  from: (...args: unknown[]) => mockFromImpl(...args),
  rpc: (...args: unknown[]) => mockRpcImpl(...args),
  auth: {
    getUser: async () => ({ data: getUserReturn }),
  },
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => mockSupabaseClient,
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserIsSuperAdmin: async () => isSuperAdminReturn,
  getCurrentUserRoles: async () =>
    isSuperAdminReturn
      ? [{ role: "super_admin", scope_type: "org", scope_id: null }]
      : [],
  // Preview route doesn't need the community/microgrid helpers, but the
  // shared module imports them transitively — stub to prevent accidental
  // real imports from hitting `server-only`.
  currentUserCanAccessCommunity: async () => true,
  currentUserCanAccessMicrogrid: async () => true,
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Small helper: build a .from() chain that resolves to the given entity
// lookup (maybeSingle) result. Other .from() calls default to an empty
// "no rows" shape — descendant counters and similar calls just come back
// with `count: 0`.
function configureEntityLookup(result: {
  data: { id: string; name: string } | null;
  error: { code?: string; message: string } | null;
}) {
  // Build a thenable stub that also supports unlimited `.eq()` chaining
  // and an `.in()` terminator. Both count-style (head:true) and non-count
  // calls resolve to an empty shape — exact counts don't affect the HTTP
  // contract being tested here.
  //
  // The descendant counter uses chains like
  // `qb.eq("scope_type", "org").eq("scope_id", orgId)` (which awaits the
  // second `.eq`) and `qb.in("col", values)` as the terminator. The stub
  // is both a Promise and a chainable — `await` uses the Promise side,
  // further chained `.eq()` / `.in()` calls return the same stub.
  function chainable(result: { data: unknown; error: unknown; count?: number }) {
    const stub: {
      eq: (...args: unknown[]) => typeof stub;
      in: (...args: unknown[]) => typeof stub;
      maybeSingle: () => Promise<unknown>;
      then: (
        onFulfilled: (v: unknown) => unknown
      ) => Promise<unknown>;
    } = {
      eq: () => stub,
      in: () => stub,
      maybeSingle: () => Promise.resolve(result),
      then: (onFulfilled) => Promise.resolve(result).then(onFulfilled),
    };
    return stub;
  }

  mockFromImpl.mockImplementation((table: string) => {
    if (table === "organizations") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => result,
          }),
        }),
      };
    }
    return {
      select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.head) {
          return chainable({ data: null, error: null, count: 0 });
        }
        return chainable({ data: [], error: null });
      },
    };
  });
}

const VALID_UUID = "550e8400-e29b-41d4-a716-446655440000";

function makeRequest(): NextRequest {
  return new NextRequest(`http://localhost/api/organizations/${VALID_UUID}`, {
    method: "DELETE",
  });
}

describe("DELETE /api/organizations/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSuperAdminReturn = true;
    getUserReturn = { user: { id: "user-1" } };
  });

  it("returns 400 for malformed UUID", async () => {
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(
      new NextRequest(`http://localhost/api/organizations/not-a-uuid`, {
        method: "DELETE",
      }),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Invalid organization id");
  });

  it("returns 403 when caller is not super_admin", async () => {
    isSuperAdminReturn = false;
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toContain("You do not have permission");
  });

  it("returns 404 when the organization does not exist", async () => {
    configureEntityLookup({ data: null, error: null });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Organization not found.");
  });

  it("returns 204 on happy path and logs entity.delete with the exact AC-LOG-1 payload shape", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "NFE" },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({ data: 1, error: null });

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_UUID }),
    });

    expect(res.status).toBe(204);
    expect(mockRpcImpl).toHaveBeenCalledWith("fn_entity_delete_org", {
      p_id: VALID_UUID,
    });

    // AC-LOG-1: exact shape + keys.
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(infoSpy.mock.calls[0][0] as string);
    expect(logged.event).toBe("entity.delete");
    expect(logged.entity_kind).toBe("organization");
    expect(logged.entity_id).toBe(VALID_UUID);
    expect(logged.entity_name).toBe("NFE");
    expect(logged.actor_user_id).toBe("user-1");
    expect(logged.actor_role).toBe("super_admin");
    expect(logged.descendant_counts).toBeDefined();
    expect(logged.descendant_counts.kind).toBe("organization");
    expect(logged.at).toMatch(/\d{4}-\d{2}-\d{2}T/);

    infoSpy.mockRestore();
  });

  it("returns 404 on repeat delete (idempotency per AC-ROUTE-7)", async () => {
    // Second DELETE — the entity still exists at lookup time (race). The
    // RPC returns 0 rows deleted (RLS hid it, or it vanished under our
    // feet). Per AC-ROUTE-7 we map that to 404 so the UI can't blindly
    // retry a stale tab.
    configureEntityLookup({
      data: { id: VALID_UUID, name: "NFE" },
      error: null,
    });
    mockRpcImpl.mockResolvedValueOnce({ data: 0, error: null });

    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when entity has an empty name (cannot type-to-confirm)", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "" },
      error: null,
    });
    const { DELETE } = await import("../[id]/route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_UUID }),
    });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("Unnamed entity");
  });
});

describe("GET /api/organizations/[id]/delete-preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    isSuperAdminReturn = true;
  });

  it("returns 400 for malformed UUID", async () => {
    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(`http://localhost/api/organizations/not-a-uuid/delete-preview`),
      { params: Promise.resolve({ id: "not-a-uuid" }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when caller cannot access the entity (permission parity AC-ROUTE-4)", async () => {
    isSuperAdminReturn = false;
    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/organizations/${VALID_UUID}/delete-preview`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 with the expected response shape on happy path", async () => {
    configureEntityLookup({
      data: { id: VALID_UUID, name: "NFE" },
      error: null,
    });

    const { GET } = await import("../[id]/delete-preview/route");
    const res = await GET(
      new NextRequest(
        `http://localhost/api/organizations/${VALID_UUID}/delete-preview`
      ),
      { params: Promise.resolve({ id: VALID_UUID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entity).toEqual({ id: VALID_UUID, name: "NFE" });
    expect(json.descendant_counts).toBeDefined();
    expect(json.descendant_counts.kind).toBe("organization");
    expect(typeof json.as_of).toBe("string");
    // parent is null for Org per AC-ROUTE-3.
    expect(json.parent).toBeNull();
  });
});
