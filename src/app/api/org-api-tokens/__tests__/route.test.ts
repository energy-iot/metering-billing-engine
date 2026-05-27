/**
 * POST /api/org-api-tokens — route tests (#256).
 *
 * Failure-mode AC matrix from the ticket body:
 *
 *   - 400 on malformed body / missing org_id UUID
 *   - 422 on missing name / overlong name
 *   - 403 when caller is not super_admin AND not org_manager for org_id
 *   - 401 when getUser() returns no user (session expired mid-flight)
 *   - 201 happy path: returns { id, plaintext }; writes one
 *     `org_api_tokens` row + one `billing_audit_log` row with
 *     event_type='token_generated' and org_id=<the token's org>
 *   - 500 + warn-log when audit row insert fails (route still returns 201
 *     and the plaintext)
 *
 * Supabase + auth are mocked at the module boundary. `insertsByTable`
 * captures per-table inserts so we can assert against both the token
 * row and the audit row independently (PR #259 lesson — single-variable
 * capture silently drops the non-last write).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const VALID_ORG_ID = "11111111-1111-4000-8000-000000000001";
const TOKEN_ID = "22222222-2222-4000-8000-000000000002";
const USER_ID = "33333333-3333-4000-8000-000000000003";

const mockRevalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: mockRevalidatePath }));

let canAccessOrg = true;
let getUserResult: { data: { user: { id: string } | null } } = {
  data: { user: { id: USER_ID } },
};
let insertsByTable: Record<string, Array<Record<string, unknown>>> = {};
let tokenInsertResult: {
  data: { id: string } | null;
  error: { message: string; code?: string } | null;
} = { data: { id: TOKEN_ID }, error: null };
let auditInsertResult: { error: { message: string; code?: string } | null } = {
  error: null,
};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: () => Promise.resolve(getUserResult),
    },
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        if (!insertsByTable[table]) insertsByTable[table] = [];
        insertsByTable[table].push(payload);
        if (table === "org_api_tokens") {
          return {
            select: () => ({
              single: () => Promise.resolve(tokenInsertResult),
            }),
          };
        }
        // billing_audit_log path — bare await
        return Promise.resolve(auditInsertResult);
      },
    }),
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessOrg: async () => canAccessOrg,
}));

// Stub generateToken so we don't pay for argon2 hashing per test
// and so the plaintext + lookup are deterministic for the assertion.
vi.mock("@/lib/internal-auth", () => ({
  generateToken: () => ({
    plaintext: "mbe_dev__deadbeef_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    lookup: "deadbeef",
    envPrefix: "dev_",
    hashPromise: Promise.resolve("$argon2id$stubhash"),
  }),
}));

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/org-api-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/org-api-tokens (#256)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrg = true;
    getUserResult = { data: { user: { id: USER_ID } } };
    insertsByTable = {};
    tokenInsertResult = { data: { id: TOKEN_ID }, error: null };
    auditInsertResult = { error: null };
  });

  it("400 on invalid JSON body", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest("not-json"));
    expect(res.status).toBe(400);
  });

  it("400 with field='org_id' on missing/malformed org_id", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ name: "x" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.field).toBe("org_id");
  });

  it("422 with field='name' on missing name", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest({ org_id: VALID_ORG_ID }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.field).toBe("name");
  });

  it("422 with field='name' on overlong name", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({ org_id: VALID_ORG_ID, name: "x".repeat(121) })
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.field).toBe("name");
  });

  it("403 when caller cannot access the org", async () => {
    canAccessOrg = false;
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({ org_id: VALID_ORG_ID, name: "test-token" })
    );
    expect(res.status).toBe(403);
  });

  it("401 when session has no user (race after authz)", async () => {
    getUserResult = { data: { user: null } };
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({ org_id: VALID_ORG_ID, name: "test-token" })
    );
    expect(res.status).toBe(401);
  });

  it("201 happy path — returns { id, plaintext } and writes audit row", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({ org_id: VALID_ORG_ID, name: "customerapp-prod" })
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBe(TOKEN_ID);
    expect(body.plaintext).toMatch(/^mbe_/);

    // Token row written.
    expect(insertsByTable["org_api_tokens"]).toHaveLength(1);
    const tokRow = insertsByTable["org_api_tokens"][0];
    expect(tokRow.org_id).toBe(VALID_ORG_ID);
    expect(tokRow.name).toBe("customerapp-prod");
    expect(tokRow.token_lookup).toBe("deadbeef");
    expect(tokRow.created_by).toBe(USER_ID);

    // Audit row written.
    expect(insertsByTable["billing_audit_log"]).toHaveLength(1);
    const auditRow = insertsByTable["billing_audit_log"][0];
    expect(auditRow.event_type).toBe("token_generated");
    expect(auditRow.org_id).toBe(VALID_ORG_ID);
    expect(auditRow.billing_period_id).toBeNull();
    expect(auditRow.actor_kind).toBe("human");
    expect(auditRow.actor_user_id).toBe(USER_ID);
    expect(auditRow.actor_ref).toBeNull();
    expect(auditRow.details).toMatchObject({
      org_api_token_id: TOKEN_ID,
      name: "customerapp-prod",
    });
  });

  it("403 on RLS violation surfaced by the token insert", async () => {
    tokenInsertResult = {
      data: null,
      error: { message: "new row violates row-level security policy", code: "42501" },
    };
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({ org_id: VALID_ORG_ID, name: "x" })
    );
    expect(res.status).toBe(403);
  });

  it("still returns 201 even if audit insert fails (warn-but-still-return)", async () => {
    auditInsertResult = { error: { message: "audit table down", code: "08000" } };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { POST } = await import("../route");
    const res = await POST(
      makeRequest({ org_id: VALID_ORG_ID, name: "x" })
    );
    expect(res.status).toBe(201);
    // Body still carries the plaintext.
    const body = await res.json();
    expect(body.plaintext).toMatch(/^mbe_/);
    // Warn-log captured the audit failure.
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
