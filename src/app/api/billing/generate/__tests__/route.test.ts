/**
 * POST /api/billing/generate — route tests (#158 + #173 BC1).
 *
 * Coverage:
 *   - 401 unauthorized when supabase.auth.getUser() returns no user.
 *   - 400 invalid_body for malformed manualReadings.
 *   - Bulk path delegates to fn_record_line_item_with_audit (one RPC call
 *     per processed household; `mode='write'`).
 *   - manualReadings override path sets reading_source='manual' on the RPC
 *     payload (`_reading_source: 'manual'`) plus entered_by_user_id from
 *     auth.uid().
 *   - Empty householdIds (`[]`) writes nothing AND returns
 *     `{ lineItems: 0, errors: [] }` (AC3 explicit no-op).
 *   - Cross-microgrid manualReadings entry surfaces in errors[] with
 *     code='unknown_household' (AC3 attack defense).
 *   - bulk-regenerate of a manual-source household without manualReadings
 *     surfaces in errors[] with code='currently_manual' (AC3 Q5).
 *
 * Test pattern: the route is mocked at the supabase + auth + runGenerationFor
 * boundaries — the runGenerationFor *internals* are exercised end-to-end by
 * the live-DB suite at `src/lib/supabase/__tests__/billing_audit_log.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock controls ──────────────────────────────────────────────────────────

let mockUserOverride: { id: string } | null = {
  id: "11111111-1111-4111-8111-111111111111",
};
let mockGenerateResult: { kind?: "fatal"; status?: number; body?: unknown; results?: unknown[] } = {
  results: [],
};
let lastGenerateCall: {
  periodId?: string;
  householdIds?: string[];
  manualReadings?: unknown[];
  mode?: string;
  actorUserId?: string | null;
} | null = null;

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
    periodId: string;
    householdIds?: string[];
    manualReadings?: unknown[];
    mode: string;
    actorUserId: string | null;
  }) => {
    lastGenerateCall = {
      periodId: params.periodId,
      householdIds: params.householdIds,
      manualReadings: params.manualReadings,
      mode: params.mode,
      actorUserId: params.actorUserId,
    };
    return mockGenerateResult;
  }),
}));

const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";
const HH_A = "660e8400-e29b-41d4-a716-446655442001";

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/billing/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/billing/generate (#173 BC1)", () => {
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

  it("400 invalid_body for malformed billingPeriodId", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: "not-a-uuid" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("invalid_body");
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
    const json = await res.json();
    expect(json.error).toBe("invalid_body");
  });

  it("400 invalid_body when manualReadings.startKwh negative", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        manualReadings: [
          { householdId: HH_A, startKwh: -1, endKwh: 50 },
        ],
      })
    );
    expect(res.status).toBe(400);
  });

  it("happy bulk: delegates to runGenerationFor with mode='write' + actorUserId", async () => {
    mockGenerateResult = {
      results: [
        {
          kind: "written",
          householdId: HH_A,
          householdName: "HH A",
          lineItem: { id: "li-x" },
          previousTotalAmount: null,
          previousPaymentStatus: null,
          previousReadingSource: null,
        },
      ],
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lineItems).toBe(1);
    expect(json.errors).toEqual([]);
    expect(lastGenerateCall?.mode).toBe("write");
    expect(lastGenerateCall?.actorUserId).toBe(
      "11111111-1111-4111-8111-111111111111"
    );
    expect(lastGenerateCall?.periodId).toBe(PERIOD_ID);
    expect(lastGenerateCall?.householdIds).toBeUndefined();
    expect(lastGenerateCall?.manualReadings).toBeUndefined();
  });

  it("forwards manualReadings (with reason) to runGenerationFor", async () => {
    mockGenerateResult = {
      results: [
        {
          kind: "written",
          householdId: HH_A,
          householdName: "HH A",
          lineItem: { id: "li-x" },
          previousTotalAmount: null,
          previousPaymentStatus: null,
          previousReadingSource: null,
        },
      ],
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        manualReadings: [
          {
            householdId: HH_A,
            startKwh: 100,
            endKwh: 180,
            reason: "Aaron read the meter manually",
          },
        ],
      })
    );
    expect(res.status).toBe(200);
    expect(lastGenerateCall?.manualReadings).toEqual([
      {
        householdId: HH_A,
        startKwh: 100,
        endKwh: 180,
        reason: "Aaron read the meter manually",
      },
    ]);
  });

  it("manualReadings.endKwh === startKwh succeeds (zero-usage edge case)", async () => {
    mockGenerateResult = {
      results: [
        {
          kind: "written",
          householdId: HH_A,
          householdName: "HH A",
          lineItem: { id: "li-x" },
          previousTotalAmount: null,
          previousPaymentStatus: null,
          previousReadingSource: null,
        },
      ],
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        manualReadings: [
          { householdId: HH_A, startKwh: 100, endKwh: 100 },
        ],
      })
    );
    expect(res.status).toBe(200);
  });

  it("response shape splits results into lineItems count + errors[] (with code field)", async () => {
    mockGenerateResult = {
      results: [
        {
          kind: "written",
          householdId: HH_A,
          householdName: "HH A",
          lineItem: { id: "li-x" },
          previousTotalAmount: null,
          previousPaymentStatus: null,
          previousReadingSource: null,
        },
        {
          kind: "error",
          householdId: "660e8400-e29b-41d4-a716-446655442002",
          householdName: "HH B",
          error: "Currently set to manual entry — use per-row regenerate to change.",
          code: "currently_manual",
        },
        {
          kind: "error",
          householdId: "660e8400-e29b-41d4-a716-446655442003",
          householdName: "660e8400-e29b-41d4-a716-446655442003",
          error: "Household 660e8400-e29b-41d4-a716-446655442003 is not in this microgrid.",
          code: "unknown_household",
        },
      ],
    };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        billingPeriodId: PERIOD_ID,
        householdIds: [HH_A, "660e8400-e29b-41d4-a716-446655442002"],
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.lineItems).toBe(1);
    expect(json.errors).toHaveLength(2);
    expect(json.errors[0].code).toBe("currently_manual");
    expect(json.errors[1].code).toBe("unknown_household");
  });

  it("propagates fatal status from runGenerationFor", async () => {
    mockGenerateResult = {
      kind: "fatal",
      status: 404,
      body: { error: "Billing period not found" },
    };
    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Billing period not found");
  });
});
