/**
 * POST /api/v1/billing/generate — route tests (#254 authorization layer).
 *
 * Coverage (AC matrix from the ticket body):
 *
 *   Authentication (carried over from #255):
 *     - Token auth fails → 401 with reason.
 *
 *   Authorization — payload `microgrid_id` cross-check:
 *     - Missing `microgrid_id` → 400.
 *     - Malformed `microgrid_id` (not UUID) → 400.
 *     - Non-existent `microgrid_id` → 404 (NOT 403 — UUID-enumeration
 *       defense; never reveal "exists in some other org").
 *     - `microgrid_id` resolves to an org other than the token's → 403
 *       with reason `microgrid_outside_token_org`.
 *
 *   Authorization — `billingPeriodId` cross-check (period's microgrid → org):
 *     - Period not found → 404.
 *     - Period belongs to a microgrid in another org → 403.
 *
 *   Happy path:
 *     - Token org + payload microgrid org + period microgrid org all
 *       match → calls `runGenerationFor` with the resolved token name as
 *       `actorRef`, returns 200 with `lineItems` shape.
 *
 * Mocks `@/lib/internal-auth` (for both `resolveOrgFromToken` and
 * `resolveMicrogridOrgId`), `@/lib/supabase/service` (for the period
 * lookup performed by the route itself), and `@/lib/billing/generate`
 * (so we don't touch the engine internals; AC matrix is route-layer).
 *
 * The `insertsByTable` mock idiom is borrowed from #253/#255's
 * `src/app/api/v1/billing-periods/__tests__/route.test.ts`; here we only
 * need a `select().eq().maybeSingle()` chain for the period lookup, since
 * the route doesn't insert anything itself (the engine owns all writes).
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

type MicrogridOrgResult =
  | { ok: true; org_id: string }
  | { ok: false; status: 404 | 400; reason: string };

// Default is a constant; tests may swap in a function that dispatches on
// the microgrid_id argument (e.g. for the "period in another org" case
// where the payload microgrid resolves to org A but the period's
// microgrid resolves to org B in the same call).
let mockMicrogridOrgResolver:
  | MicrogridOrgResult
  | ((microgrid_id: string) => MicrogridOrgResult) = {
  ok: true,
  org_id: "org-uuid-1",
};

// Period lookup mock: route does
//   supabase.from("billing_periods").select("id, microgrid_id").eq("id", id).maybeSingle()
type PeriodRow = { id: string; microgrid_id: string } | null;
let mockPeriodResult: { data: PeriodRow; error: { message: string } | null } = {
  data: {
    id: "550e8400-e29b-41d4-a716-446655440100",
    microgrid_id: "550e8400-e29b-41d4-a716-446655440000",
  },
  error: null,
};

// runGenerationFor mock — we capture the params so we can assert that the
// route passed through the right (actorKind, actorRef) on the happy path.
let runGenerationCalls: Array<Record<string, unknown>> = [];
let mockGenerationOutput: unknown = {
  results: [
    {
      kind: "written",
      householdId: "hh-1",
      householdName: "Alice",
      lineItem: { id: "li-1", total_amount: 1234, usage_kwh: 50 },
    },
  ],
};

vi.mock("@/lib/internal-auth", () => ({
  resolveOrgFromToken: () => Promise.resolve(mockAuthResult),
  resolveMicrogridOrgId: (_supabase: unknown, microgrid_id: string) => {
    const result =
      typeof mockMicrogridOrgResolver === "function"
        ? mockMicrogridOrgResolver(microgrid_id)
        : mockMicrogridOrgResolver;
    return Promise.resolve(result);
  },
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (_table: string) => ({
      select: (_cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: () => Promise.resolve(mockPeriodResult),
          single: () => Promise.resolve(mockPeriodResult),
        }),
      }),
    }),
  }),
}));

vi.mock("@/lib/billing/generate", () => ({
  runGenerationFor: (params: Record<string, unknown>) => {
    runGenerationCalls.push(params);
    return Promise.resolve(mockGenerationOutput);
  },
  isRunGenerationFatal: (out: { kind?: string }) => out?.kind === "fatal",
}));

const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440000";
const PERIOD_ID = "550e8400-e29b-41d4-a716-446655440100";
const HOUSEHOLD_ID = "550e8400-e29b-41d4-a716-446655440200";

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/billing/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "stub" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    billingPeriodId: PERIOD_ID,
    microgrid_id: MICROGRID_ID,
    manualReadings: [
      { householdId: HOUSEHOLD_ID, startKwh: 0, endKwh: 50 },
    ],
    ...overrides,
  };
}

describe("POST /api/v1/billing/generate (#254)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult = {
      ok: true,
      org_id: "org-uuid-1",
      token_id: "token-uuid-1",
      token_name: "customerapp-prod-2026",
    };
    mockMicrogridOrgResolver = { ok: true, org_id: "org-uuid-1" };
    mockPeriodResult = {
      data: { id: PERIOD_ID, microgrid_id: MICROGRID_ID },
      error: null,
    };
    runGenerationCalls = [];
    mockGenerationOutput = {
      results: [
        {
          kind: "written",
          householdId: "hh-1",
          householdName: "Alice",
          lineItem: { id: "li-1", total_amount: 1234, usage_kwh: 50 },
        },
      ],
    };
  });

  // ── Authentication ─────────────────────────────────────────────────────────

  it("401 when auth fails", async () => {
    mockAuthResult = { ok: false, status: 401, reason: "missing_header" };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(validBody()));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("missing_header");
    expect(runGenerationCalls).toHaveLength(0);
  });

  // ── Payload shape ──────────────────────────────────────────────────────────

  it("400 when microgrid_id is missing", async () => {
    const { POST } = await import("../route");
    const body = validBody();
    delete (body as Record<string, unknown>).microgrid_id;
    const res = await POST(makePostRequest(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/microgrid_id/);
    expect(runGenerationCalls).toHaveLength(0);
  });

  it("400 when microgrid_id is malformed (not a UUID)", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest(validBody({ microgrid_id: "not-a-uuid" })),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/microgrid_id/);
    expect(runGenerationCalls).toHaveLength(0);
  });

  it("400 when billingPeriodId is missing", async () => {
    const { POST } = await import("../route");
    const body = validBody();
    delete (body as Record<string, unknown>).billingPeriodId;
    const res = await POST(makePostRequest(body));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/billingPeriodId/);
  });

  // ── Authorization — payload microgrid cross-check ─────────────────────────

  it("404 (NOT 403) when payload microgrid_id does not exist — UUID-enum defense", async () => {
    mockMicrogridOrgResolver = {
      ok: false,
      status: 404,
      reason: "microgrid_not_found",
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(validBody()));
    // 404 distinguishes "not found" from "found but wrong org" (403).
    // An attacker MUST NOT be able to tell from the response shape
    // whether a UUID exists in some other org or doesn't exist at all.
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("microgrid_not_found");
    expect(runGenerationCalls).toHaveLength(0);
  });

  it("403 when payload microgrid belongs to another org", async () => {
    mockMicrogridOrgResolver = { ok: true, org_id: "org-uuid-OTHER" };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(validBody()));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("microgrid_outside_token_org");
    expect(runGenerationCalls).toHaveLength(0);
  });

  // ── Authorization — period cross-check ────────────────────────────────────

  it("404 when billingPeriodId does not exist", async () => {
    mockPeriodResult = { data: null, error: null };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(validBody()));
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe("billing_period_not_found");
    expect(runGenerationCalls).toHaveLength(0);
  });

  it("403 when billingPeriodId belongs to a microgrid in another org", async () => {
    // Payload microgrid is in the token's org (org-uuid-1); the period
    // row points at a DIFFERENT microgrid whose resolution returns a
    // different org. The route resolves the payload microgrid first
    // (matches → continues), then resolves the period's microgrid
    // (mismatches → 403).
    const PERIOD_MICROGRID_OTHER_ORG = "550e8400-e29b-41d4-a716-44665544FFFF";
    mockPeriodResult = {
      data: { id: PERIOD_ID, microgrid_id: PERIOD_MICROGRID_OTHER_ORG },
      error: null,
    };
    // Dispatch the resolver on input: payload microgrid → token's org;
    // period's microgrid → other org.
    mockMicrogridOrgResolver = (microgrid_id: string) => {
      if (microgrid_id === MICROGRID_ID) {
        return { ok: true, org_id: "org-uuid-1" };
      }
      if (microgrid_id === PERIOD_MICROGRID_OTHER_ORG) {
        return { ok: true, org_id: "org-uuid-OTHER" };
      }
      return { ok: false, status: 404, reason: "microgrid_not_found" };
    };

    const { POST } = await import("../route");
    const res = await POST(makePostRequest(validBody()));

    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("microgrid_outside_token_org");
    expect(runGenerationCalls).toHaveLength(0);
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("200 + delegates to runGenerationFor with token_name as actorRef when all checks pass", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest(validBody()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lineItems).toEqual([
      {
        id: "li-1",
        householdId: "hh-1",
        householdName: "Alice",
        totalAmount: 1234,
        usageKwh: 50,
      },
    ]);
    expect(runGenerationCalls).toHaveLength(1);
    expect(runGenerationCalls[0]).toMatchObject({
      periodId: PERIOD_ID,
      mode: "write",
      actorUserId: null,
      actorKind: "customerapp",
      actorRef: "customerapp-prod-2026",
    });
  });
});
