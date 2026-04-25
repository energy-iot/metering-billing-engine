/**
 * POST /api/billing/regenerate-preview — route tests (#173 BC1).
 *
 * Coverage:
 *   - 401 unauthorized when no auth user.
 *   - 400 invalid_body when manualReadings.endKwh < startKwh.
 *   - 200 returns shaped { preview, errors } with previousTotalAmount /
 *     previousPaymentStatus passthrough from runGenerationFor's preview
 *     results.
 *   - delegates to runGenerationFor with mode='preview'.
 *
 * The "no DB write" assertion is an integration concern owned by the
 * live-DB suite at `src/lib/supabase/__tests__/billing_audit_log.test.ts`
 * — here we only verify the route shape and dispatch.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let mockUserOverride: { id: string } | null = {
  id: "11111111-1111-4111-8111-111111111111",
};
let mockGenerateResult: { kind?: "fatal"; status?: number; body?: unknown; results?: unknown[] } = {
  results: [],
};
let lastGenerateCall: { mode?: string; manualReadings?: unknown[] } | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: vi.fn(),
    auth: {
      getUser: async () => ({
        data: { user: mockUserOverride },
        error: null,
      }),
    },
  }),
}));

vi.mock("@/lib/billing/generate", async () => ({
  isRunGenerationFatal: (out: { kind?: string }) =>
    Boolean(out && out.kind === "fatal"),
  runGenerationFor: vi.fn(async (params: {
    mode: string;
    manualReadings?: unknown[];
  }) => {
    lastGenerateCall = {
      mode: params.mode,
      manualReadings: params.manualReadings,
    };
    return mockGenerateResult;
  }),
}));

const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";
const HH_A = "660e8400-e29b-41d4-a716-446655442001";

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/billing/regenerate-preview", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/billing/regenerate-preview (#173 BC1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserOverride = { id: "11111111-1111-4111-8111-111111111111" };
    mockGenerateResult = { results: [] };
    lastGenerateCall = null;
  });

  it("401 when no auth user", async () => {
    mockUserOverride = null;
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(401);
  });

  it("400 invalid_body when manualReadings.endKwh < startKwh", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        manualReadings: [
          { householdId: HH_A, startKwh: 100, endKwh: 50 },
        ],
      })
    );
    expect(res.status).toBe(400);
  });

  it("delegates to runGenerationFor with mode='preview'", async () => {
    mockGenerateResult = {
      results: [
        {
          kind: "preview",
          householdId: HH_A,
          householdName: "HH A",
          startKwh: 100,
          endKwh: 200,
          usageKwh: 100,
          tierBreakdown: [{ label: "Tier 1", kwh: 50, amount: 25000 }],
          totalAmount: 49000,
          previousTotalAmount: 12000,
          previousPaymentStatus: "paid",
        },
      ],
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        householdIds: [HH_A],
      })
    );
    expect(res.status).toBe(200);
    expect(lastGenerateCall?.mode).toBe("preview");
    const json = await res.json();
    expect(json.preview).toHaveLength(1);
    expect(json.preview[0]).toMatchObject({
      householdId: HH_A,
      householdName: "HH A",
      previousTotalAmount: 12000,
      previousPaymentStatus: "paid",
      totalAmount: 49000,
    });
    expect(json.errors).toEqual([]);
  });

  it("preview shape includes previous* fields when prior line item exists", async () => {
    mockGenerateResult = {
      results: [
        {
          kind: "preview",
          householdId: HH_A,
          householdName: "HH A",
          startKwh: 0,
          endKwh: 0,
          usageKwh: 0,
          tierBreakdown: [],
          totalAmount: 0,
          previousTotalAmount: null,
          previousPaymentStatus: null,
        },
      ],
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preview[0].previousTotalAmount).toBeNull();
    expect(json.preview[0].previousPaymentStatus).toBeNull();
  });

  it("propagates fatal status from runGenerationFor", async () => {
    mockGenerateResult = {
      kind: "fatal",
      status: 400,
      body: { error: "No rate schedule found for this microgrid" },
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(400);
  });

  it("response splits errors with code field", async () => {
    mockGenerateResult = {
      results: [
        {
          kind: "error",
          householdId: HH_A,
          householdName: "HH A",
          error: "Currently set to manual entry — use per-row regenerate to change.",
          code: "currently_manual",
        },
      ],
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({ billingPeriodId: PERIOD_ID, householdIds: [HH_A] })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.preview).toEqual([]);
    expect(json.errors).toHaveLength(1);
    expect(json.errors[0].code).toBe("currently_manual");
  });
});
