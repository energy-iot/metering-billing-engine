/**
 * GET /api/v1/microgrids — route tests (#257).
 *
 * Coverage (failure-mode AC from the ticket body):
 *   - Auth fails (missing header / unknown token / revoked) → 401, reason
 *     surfaces in the error body.
 *   - customerapp_enabled = FALSE for the token's org → 403 (gated inside
 *     `resolveOrgFromToken` per #251; this test pins the surfacing).
 *   - Token's org has 1 microgrid → 200 with array of length 1, shape
 *     `{ id, name, currency, community_name }`.
 *   - Token's org has 0 microgrids → 200 with `[]` (NOT 404; the resource
 *     exists, it's just empty).
 *   - Token's org has 3 microgrids, another org has 2 → 200 returns only
 *     the 3 from token's org (the `.eq("communities.org_id", …)` filter
 *     does the work; this mocks the filtered result the supabase chain
 *     would have returned).
 *   - Supabase error → 500 surfaces the message.
 *
 * The route mocks `resolveOrgFromToken` + the supabase service client at
 * the module boundary (same idiom as billing-periods/route.test.ts). Live-DB
 * row visibility is verified by the higher-level integration suites; here we
 * pin the route-layer plumbing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock controls ──────────────────────────────────────────────────────────

let mockAuthResult: {
  ok: boolean;
  org_id?: string;
  token_id?: string;
  token_name?: string;
  status?: number;
  reason?: string;
} = {
  ok: true,
  org_id: "org-uuid-1",
  token_id: "token-uuid-1",
  token_name: "customerapp-prod-2026",
};

// The `.select(...).eq(...)` chain on the supabase client returns a
// thenable that resolves to `{ data, error }`. Tests set the resolved
// value via `mockSelectResult`; the chain mock simply yields it on await.
let mockSelectResult: {
  data:
    | Array<{
        id: string;
        name: string;
        currency: string;
        community_id?: string;
        communities: { name: string; org_id: string } | null;
      }>
    | null;
  error: { message: string } | null;
} = { data: [], error: null };

// Captured at each .from(...) call so tests can assert which table was
// queried + which filter was applied.
let lastQuery: {
  table: string | null;
  selectArg: string | null;
  eqArgs: Array<[string, unknown]>;
} = { table: null, selectArg: null, eqArgs: [] };

vi.mock("@/lib/internal-auth", () => ({
  resolveOrgFromToken: () => Promise.resolve(mockAuthResult),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      lastQuery.table = table;
      const builder = {
        select: (arg: string) => {
          lastQuery.selectArg = arg;
          return builder;
        },
        eq: (col: string, val: unknown) => {
          lastQuery.eqArgs.push([col, val]);
          return builder;
        },
        then: (resolve: (v: typeof mockSelectResult) => unknown) =>
          Promise.resolve(mockSelectResult).then(resolve),
      };
      return builder;
    },
  }),
}));

function makeGetRequest(): NextRequest {
  return new NextRequest("http://localhost/api/v1/microgrids", {
    method: "GET",
    headers: { "x-api-key": "stub" },
  });
}

describe("GET /api/v1/microgrids (#257)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult = {
      ok: true,
      org_id: "org-uuid-1",
      token_id: "token-uuid-1",
      token_name: "customerapp-prod-2026",
    };
    mockSelectResult = { data: [], error: null };
    lastQuery = { table: null, selectArg: null, eqArgs: [] };
  });

  it("401 when x-api-key header is missing", async () => {
    mockAuthResult = { ok: false, status: 401, reason: "missing_header" };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("missing_header");
  });

  it("401 when token is unknown / revoked", async () => {
    mockAuthResult = { ok: false, status: 401, reason: "not_found" };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("not_found");
  });

  it("403 when customerapp_enabled = FALSE for the token's org (#251)", async () => {
    mockAuthResult = {
      ok: false,
      status: 403,
      reason: "customerapp_not_enabled",
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("customerapp_not_enabled");
  });

  it("200 with empty array when token's org has 0 microgrids (NOT 404)", async () => {
    mockSelectResult = { data: [], error: null };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
    // Sanity: the filter was applied to the right org.
    expect(lastQuery.table).toBe("microgrids");
    expect(lastQuery.eqArgs).toEqual([["communities.org_id", "org-uuid-1"]]);
  });

  it("200 with shaped row when token's org has 1 microgrid", async () => {
    mockSelectResult = {
      data: [
        {
          id: "mg-uuid-1",
          name: "Kasese Microgrid 1",
          currency: "UGX",
          community_id: "comm-uuid-1",
          communities: { name: "Kasese", org_id: "org-uuid-1" },
        },
      ],
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      {
        id: "mg-uuid-1",
        name: "Kasese Microgrid 1",
        currency: "UGX",
        community_name: "Kasese",
      },
    ]);
  });

  it("200 with multiple rows when token's org has 3 microgrids", async () => {
    mockSelectResult = {
      data: [
        {
          id: "mg-uuid-1",
          name: "MG1",
          currency: "UGX",
          communities: { name: "Comm1", org_id: "org-uuid-1" },
        },
        {
          id: "mg-uuid-2",
          name: "MG2",
          currency: "UGX",
          communities: { name: "Comm1", org_id: "org-uuid-1" },
        },
        {
          id: "mg-uuid-3",
          name: "MG3",
          currency: "USD",
          communities: { name: "Comm2", org_id: "org-uuid-1" },
        },
      ],
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toHaveLength(3);
    expect(json.map((r: { id: string }) => r.id)).toEqual([
      "mg-uuid-1",
      "mg-uuid-2",
      "mg-uuid-3",
    ]);
    // None of the other-org rows leak — because the supabase filter is the
    // mechanism (here verified by the .eq arg shape).
    expect(lastQuery.eqArgs).toEqual([["communities.org_id", "org-uuid-1"]]);
  });

  it("handles PostgREST returning communities as a 1-element array (defensive narrowing)", async () => {
    // PostgREST sometimes returns the embedded relation as an array even
    // for !inner; the route narrows both shapes. This pins that branch.
    mockSelectResult = {
      data: [
        {
          id: "mg-uuid-1",
          name: "MG1",
          currency: "UGX",
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          communities: [{ name: "Kasese", org_id: "org-uuid-1" }] as any,
        },
      ],
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].community_name).toBe("Kasese");
  });

  it("uses the customerapp-narrow column list, not select('*')", async () => {
    mockSelectResult = { data: [], error: null };
    const { GET } = await import("../route");
    await GET(makeGetRequest());
    expect(lastQuery.selectArg).not.toMatch(/\bselect\(['"]\*/);
    expect(lastQuery.selectArg).toContain("id, name, currency, community_id");
    expect(lastQuery.selectArg).toContain("communities!inner(name, org_id)");
  });

  it("500 when supabase errors", async () => {
    mockSelectResult = {
      data: null,
      error: { message: "connection refused" },
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("connection refused");
  });
});
