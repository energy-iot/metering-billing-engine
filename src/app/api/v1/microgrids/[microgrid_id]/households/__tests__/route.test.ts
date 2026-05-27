/**
 * GET /api/v1/microgrids/:microgrid_id/households — route tests (#257).
 *
 * Coverage (failure-mode AC from the ticket body):
 *   - Auth fails → 401 with reason surface.
 *   - customerapp_enabled = FALSE → 403 (gated inside `resolveOrgFromToken`
 *     per #251).
 *   - Malformed `:microgrid_id` UUID → 400 (rejected inside
 *     `resolveMicrogridOrgId`).
 *   - Non-existent microgrid → 404 (rejected inside `resolveMicrogridOrgId`
 *     BEFORE the org-equality check, per the UUID-enumeration defense in
 *     `src/lib/internal-auth.ts`).
 *   - Wrong-org microgrid → 403.
 *   - 0 households on the microgrid → 200 with `[]` (NOT 404; the
 *     microgrid resource exists, the collection is just empty).
 *   - N households with various `household_devices` shapes → 200 with
 *     `has_device` correctly computed from the embed length.
 *   - Supabase error → 500 surfaces the message.
 *
 * `resolveOrgFromToken` + `resolveMicrogridOrgId` are both mocked at the
 * module boundary (same idiom as billing-periods/route.test.ts). The
 * supabase chain mock follows the same pattern as the sibling
 * microgrids/route.test.ts.
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

let mockResolveMgResult:
  | { ok: true; org_id: string }
  | { ok: false; status: 400 | 404; reason: string } = {
  ok: true,
  org_id: "org-uuid-1",
};

let mockSelectResult: {
  data:
    | Array<{
        id: string;
        display_name: string;
        microgrid_id: string;
        household_devices?: Array<{ device_id: string }> | null;
      }>
    | null;
  error: { message: string } | null;
} = { data: [], error: null };

let lastQuery: {
  table: string | null;
  selectArg: string | null;
  eqArgs: Array<[string, unknown]>;
} = { table: null, selectArg: null, eqArgs: [] };

vi.mock("@/lib/internal-auth", () => ({
  resolveOrgFromToken: () => Promise.resolve(mockAuthResult),
  resolveMicrogridOrgId: () => Promise.resolve(mockResolveMgResult),
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

const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440000";
const MALFORMED_MICROGRID_ID = "not-a-uuid";

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/v1/microgrids/${MICROGRID_ID}/households`,
    {
      method: "GET",
      headers: { "x-api-key": "stub" },
    },
  );
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ microgrid_id: id }) };
}

describe("GET /api/v1/microgrids/:microgrid_id/households (#257)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult = {
      ok: true,
      org_id: "org-uuid-1",
      token_id: "token-uuid-1",
      token_name: "customerapp-prod-2026",
    };
    mockResolveMgResult = { ok: true, org_id: "org-uuid-1" };
    mockSelectResult = { data: [], error: null };
    lastQuery = { table: null, selectArg: null, eqArgs: [] };
  });

  it("401 when x-api-key is missing", async () => {
    mockAuthResult = { ok: false, status: 401, reason: "missing_header" };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("missing_header");
  });

  it("401 when token is unknown / revoked", async () => {
    mockAuthResult = { ok: false, status: 401, reason: "not_found" };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(401);
  });

  it("403 when customerapp_enabled = FALSE for the token's org (#251)", async () => {
    mockAuthResult = {
      ok: false,
      status: 403,
      reason: "customerapp_not_enabled",
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("customerapp_not_enabled");
  });

  it("400 when :microgrid_id is malformed", async () => {
    mockResolveMgResult = {
      ok: false,
      status: 400,
      reason: "microgrid_id_malformed",
    };
    const { GET } = await import("../route");
    const res = await GET(
      makeGetRequest(),
      paramsFor(MALFORMED_MICROGRID_ID),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("microgrid_id_malformed");
  });

  it("404 when :microgrid_id does not exist", async () => {
    mockResolveMgResult = {
      ok: false,
      status: 404,
      reason: "microgrid_not_found",
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("microgrid_not_found");
  });

  it("403 when :microgrid_id belongs to a DIFFERENT org than the token", async () => {
    // 404-vs-403 ordering matters: the resolver returns ok+org_id; the
    // route's own comparison surfaces the 403. A non-existent UUID would
    // 404 first (above), so a 403 here genuinely means "exists, wrong org".
    mockResolveMgResult = { ok: true, org_id: "org-uuid-OTHER" };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("microgrid_not_in_org");
  });

  it("200 with [] when the microgrid has 0 households (NOT 404)", async () => {
    mockResolveMgResult = { ok: true, org_id: "org-uuid-1" };
    mockSelectResult = { data: [], error: null };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([]);
    expect(lastQuery.table).toBe("households");
    expect(lastQuery.eqArgs).toEqual([["microgrid_id", MICROGRID_ID]]);
  });

  it("computes has_device=true when household_devices is non-empty", async () => {
    mockSelectResult = {
      data: [
        {
          id: "hh-uuid-1",
          display_name: "Household 1",
          microgrid_id: MICROGRID_ID,
          household_devices: [{ device_id: "dev-uuid-1" }],
        },
      ],
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual([
      {
        id: "hh-uuid-1",
        display_name: "Household 1",
        microgrid_id: MICROGRID_ID,
        has_device: true,
      },
    ]);
  });

  it("computes has_device=false when household_devices is empty array", async () => {
    mockSelectResult = {
      data: [
        {
          id: "hh-uuid-1",
          display_name: "Household 1",
          microgrid_id: MICROGRID_ID,
          household_devices: [],
        },
      ],
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].has_device).toBe(false);
  });

  it("computes has_device=false when household_devices is missing/null", async () => {
    mockSelectResult = {
      data: [
        {
          id: "hh-uuid-1",
          display_name: "Household 1",
          microgrid_id: MICROGRID_ID,
          household_devices: null,
        },
      ],
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json[0].has_device).toBe(false);
  });

  it("returns mixed has_device across multiple rows", async () => {
    mockSelectResult = {
      data: [
        {
          id: "hh-uuid-1",
          display_name: "HH1",
          microgrid_id: MICROGRID_ID,
          household_devices: [{ device_id: "d1" }, { device_id: "d2" }],
        },
        {
          id: "hh-uuid-2",
          display_name: "HH2",
          microgrid_id: MICROGRID_ID,
          household_devices: [],
        },
        {
          id: "hh-uuid-3",
          display_name: "HH3",
          microgrid_id: MICROGRID_ID,
          household_devices: [{ device_id: "d3" }],
        },
      ],
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.map((r: { has_device: boolean }) => r.has_device)).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("uses the customerapp-narrow column list, not select('*')", async () => {
    mockSelectResult = { data: [], error: null };
    const { GET } = await import("../route");
    await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(lastQuery.selectArg).not.toMatch(/\bselect\(['"]\*/);
    expect(lastQuery.selectArg).toContain("id, display_name, microgrid_id");
    expect(lastQuery.selectArg).toContain("household_devices(device_id)");
  });

  it("500 when supabase errors", async () => {
    mockSelectResult = {
      data: null,
      error: { message: "connection refused" },
    };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), paramsFor(MICROGRID_ID));
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("connection refused");
  });
});
