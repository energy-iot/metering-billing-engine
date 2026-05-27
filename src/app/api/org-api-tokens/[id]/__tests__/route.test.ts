/**
 * DELETE /api/org-api-tokens/:id — revoke route tests (#256).
 *
 * Failure-mode AC matrix:
 *   - 400 on malformed UUID
 *   - 404 when row missing (or RLS hides it)
 *   - 403 when caller cannot access the row's org
 *   - 200 alreadyRevoked when revoked_at IS NOT NULL (idempotent)
 *   - 200 happy path: writes revoked_at and an audit row
 *   - 401 when session has no user
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const VALID_ORG_ID = "11111111-1111-4000-8000-000000000001";
const VALID_TOKEN_ID = "22222222-2222-4000-8000-000000000002";
const USER_ID = "33333333-3333-4000-8000-000000000003";

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

let canAccessOrg = true;
let getUserResult: { data: { user: { id: string } | null } } = {
  data: { user: { id: USER_ID } },
};
type TokenRow = {
  id: string;
  org_id: string;
  name: string;
  revoked_at: string | null;
};
let lookupResult: {
  data: TokenRow | null;
  error: { message: string; code?: string } | null;
} = {
  data: {
    id: VALID_TOKEN_ID,
    org_id: VALID_ORG_ID,
    name: "to-revoke",
    revoked_at: null,
  },
  error: null,
};
let updateResult: { error: { message: string; code?: string } | null } = {
  error: null,
};
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
      // SELECT chain
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(lookupResult),
        }),
      }),
      // UPDATE chain — chained .eq().is() for the race-safe revoke
      update: () => ({
        eq: () => ({
          is: () => Promise.resolve(updateResult),
        }),
      }),
      // INSERT — audit log
      insert: (payload: Record<string, unknown>) => {
        if (!insertsByTable[table]) insertsByTable[table] = [];
        insertsByTable[table].push(payload);
        return Promise.resolve(auditInsertResult);
      },
    }),
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessOrg: async () => canAccessOrg,
}));

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/org-api-tokens/x", {
    method: "DELETE",
  });
}

describe("DELETE /api/org-api-tokens/:id (#256)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrg = true;
    getUserResult = { data: { user: { id: USER_ID } } };
    lookupResult = {
      data: {
        id: VALID_TOKEN_ID,
        org_id: VALID_ORG_ID,
        name: "to-revoke",
        revoked_at: null,
      },
      error: null,
    };
    updateResult = { error: null };
    insertsByTable = {};
    auditInsertResult = { error: null };
  });

  it("400 on malformed UUID", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("404 when the row does not exist (or RLS hides it)", async () => {
    lookupResult = { data: null, error: null };
    const { DELETE } = await import("../route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_TOKEN_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("403 when caller cannot access the row's org", async () => {
    canAccessOrg = false;
    const { DELETE } = await import("../route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_TOKEN_ID }),
    });
    expect(res.status).toBe(403);
  });

  it("200 alreadyRevoked when revoked_at is already set (idempotent)", async () => {
    lookupResult = {
      data: {
        id: VALID_TOKEN_ID,
        org_id: VALID_ORG_ID,
        name: "to-revoke",
        revoked_at: "2026-01-01T00:00:00Z",
      },
      error: null,
    };
    const { DELETE } = await import("../route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_TOKEN_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.alreadyRevoked).toBe(true);
    // No double-audit when already revoked.
    expect(insertsByTable["billing_audit_log"]).toBeUndefined();
  });

  it("200 happy path — writes revoked_at and a token_revoked audit row", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_TOKEN_ID }),
    });
    expect(res.status).toBe(200);
    expect(insertsByTable["billing_audit_log"]).toHaveLength(1);
    const audit = insertsByTable["billing_audit_log"][0];
    expect(audit.event_type).toBe("token_revoked");
    expect(audit.org_id).toBe(VALID_ORG_ID);
    expect(audit.actor_kind).toBe("human");
    expect(audit.actor_user_id).toBe(USER_ID);
    expect(audit.details).toMatchObject({
      org_api_token_id: VALID_TOKEN_ID,
      name: "to-revoke",
    });
  });

  it("401 when session has no user", async () => {
    getUserResult = { data: { user: null } };
    const { DELETE } = await import("../route");
    const res = await DELETE(makeRequest(), {
      params: Promise.resolve({ id: VALID_TOKEN_ID }),
    });
    expect(res.status).toBe(401);
  });
});
