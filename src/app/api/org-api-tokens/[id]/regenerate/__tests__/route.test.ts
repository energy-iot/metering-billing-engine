/**
 * POST /api/org-api-tokens/:id/regenerate — route tests (#256).
 *
 * Failure-mode AC matrix:
 *   - 400 on malformed UUID
 *   - 404 on missing row
 *   - 403 on cross-org caller
 *   - 409 when the row is already revoked
 *   - 201 happy path: revokes old + creates new with same name + writes
 *     a single token_regenerated audit row with both ids in details
 *   - 409 when the race-safe revoke .is(revoked_at, null) returns count 0
 *     (another caller revoked first)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const VALID_ORG_ID = "11111111-1111-4000-8000-000000000001";
const OLD_TOKEN_ID = "22222222-2222-4000-8000-000000000002";
const NEW_TOKEN_ID = "44444444-4444-4000-8000-000000000004";
const USER_ID = "33333333-3333-4000-8000-000000000003";

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

let canAccessOrg = true;
let getUserResult: { data: { user: { id: string } | null } } = {
  data: { user: { id: USER_ID } },
};
let lookupResult: {
  data: {
    id: string;
    org_id: string;
    name: string;
    revoked_at: string | null;
  } | null;
  error: { message: string; code?: string } | null;
} = {
  data: {
    id: OLD_TOKEN_ID,
    org_id: VALID_ORG_ID,
    name: "regen-target",
    revoked_at: null,
  },
  error: null,
};
let updateResult: {
  error: { message: string; code?: string } | null;
  count: number | null;
} = { error: null, count: 1 };
let insertResult: {
  data: { id: string } | null;
  error: { message: string; code?: string } | null;
} = { data: { id: NEW_TOKEN_ID }, error: null };
let insertsByTable: Record<string, Array<Record<string, unknown>>> = {};
let auditInsertResult: { error: { message: string; code?: string } | null } = {
  error: null,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: () => Promise.resolve(getUserResult),
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(lookupResult),
        }),
      }),
      update: () => ({
        eq: () => ({
          is: () => Promise.resolve(updateResult),
        }),
      }),
      insert: (payload: Record<string, unknown>) => {
        if (!insertsByTable[table]) insertsByTable[table] = [];
        insertsByTable[table].push(payload);
        if (table === "org_api_tokens") {
          return {
            select: () => ({ single: () => Promise.resolve(insertResult) }),
          };
        }
        return Promise.resolve(auditInsertResult);
      },
    }),
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessOrg: async () => canAccessOrg,
}));

vi.mock("@/lib/internal-auth", () => ({
  generateToken: () => ({
    plaintext: "mbe_dev__cafef00d_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    lookup: "cafef00d",
    envPrefix: "dev_",
    hashPromise: Promise.resolve("$argon2id$stubhash2"),
  }),
}));

function makeRequest(): NextRequest {
  return new NextRequest(
    "http://localhost/api/org-api-tokens/x/regenerate",
    { method: "POST" }
  );
}

describe("POST /api/org-api-tokens/:id/regenerate (#256)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrg = true;
    getUserResult = { data: { user: { id: USER_ID } } };
    lookupResult = {
      data: {
        id: OLD_TOKEN_ID,
        org_id: VALID_ORG_ID,
        name: "regen-target",
        revoked_at: null,
      },
      error: null,
    };
    updateResult = { error: null, count: 1 };
    insertResult = { data: { id: NEW_TOKEN_ID }, error: null };
    insertsByTable = {};
    auditInsertResult = { error: null };
  });

  it("400 on malformed UUID", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when the row does not exist", async () => {
    lookupResult = { data: null, error: null };
    const { POST } = await import("../route");
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: OLD_TOKEN_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when caller cannot access the row's org", async () => {
    canAccessOrg = false;
    const { POST } = await import("../route");
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: OLD_TOKEN_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("409 when the row is already revoked", async () => {
    lookupResult = {
      data: {
        id: OLD_TOKEN_ID,
        org_id: VALID_ORG_ID,
        name: "regen-target",
        revoked_at: "2026-01-01T00:00:00Z",
      },
      error: null,
    };
    const { POST } = await import("../route");
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: OLD_TOKEN_ID }),
    });
    expect(res.status).toBe(409);
  });

  it("409 when concurrent revoke beats us (count=0)", async () => {
    updateResult = { error: null, count: 0 };
    const { POST } = await import("../route");
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: OLD_TOKEN_ID }),
    });
    expect(res.status).toBe(409);
  });

  it("201 happy path — single audit row with both old + new ids", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: OLD_TOKEN_ID }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(NEW_TOKEN_ID);
    expect(body.plaintext).toMatch(/^mbe_/);

    // One new token insert.
    expect(insertsByTable["org_api_tokens"]).toHaveLength(1);
    const tok = insertsByTable["org_api_tokens"][0];
    expect(tok.org_id).toBe(VALID_ORG_ID);
    expect(tok.name).toBe("regen-target");

    // Exactly one audit row of type token_regenerated.
    expect(insertsByTable["billing_audit_log"]).toHaveLength(1);
    const audit = insertsByTable["billing_audit_log"][0];
    expect(audit.event_type).toBe("token_regenerated");
    expect(audit.org_id).toBe(VALID_ORG_ID);
    expect(audit.actor_user_id).toBe(USER_ID);
    expect(audit.details).toMatchObject({
      old_token_id: OLD_TOKEN_ID,
      new_token_id: NEW_TOKEN_ID,
      name: "regen-target",
    });
  });

  it("500 with partial flag when new insert fails after old revoke", async () => {
    insertResult = {
      data: null,
      error: { message: "DB down", code: "08000" },
    };
    const { POST } = await import("../route");
    const res = await POST(makeRequest(), {
      params: Promise.resolve({ id: OLD_TOKEN_ID }),
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.partial).toBe(true);
  });
});
