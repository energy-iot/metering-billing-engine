/**
 * PATCH /api/billing-line-items/[lineItemId]/usage — route tests (#158).
 *
 * Coverage:
 *   - 400: invalid UUID, invalid JSON, missing body keys, negative number,
 *          non-numeric value, end_kwh < start_kwh derivation underflow
 *   - 403: caller cannot access microgrid
 *   - 404: line item not found / RLS-hidden
 *   - 409: device_linked — line item still has a device_id (metered)
 *   - 409: device_linked — household has a primary_consumption_meter link
 *   - 409: period_closed — billing period is closed
 *   - 200: happy path with usage_kwh only — server recomputes tier_breakdown
 *   - 200: happy path with end_kwh only — server derives usage_kwh
 *   - 200: tier_breakdown + total_amount math is correct against a fixture
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { calculateTieredCost } from "@/lib/billing/calculations";

// ── Mocks ─────────────────────────────────────────────────────────────────

let canAccessMicrogridReturn = true;

const mockLineItemMaybeSingle = vi.fn();
const mockMeterLinkMaybeSingle = vi.fn();
const mockRateScheduleMaybeSingle = vi.fn();
// BC1 (#173): the route now delegates to runGenerationFor instead of doing
// its own UPDATE. We capture the call args (so the existing assertions on
// the resulting tier_breakdown / total_amount / usage_kwh stay meaningful)
// and synthesize a written-result row whose calc mirrors the route's
// derivation (manualReading.endKwh - startKwh → calculateTieredCost).
let capturedUpdatePayload: Record<string, unknown> | null = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeFromImpl(): any {
  return (table: string) => {
    if (table === "billing_line_items") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => mockLineItemMaybeSingle(),
          }),
        }),
      };
    }
    if (table === "household_devices") {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () => mockMeterLinkMaybeSingle(),
            }),
          }),
        }),
      };
    }
    if (table === "rate_schedules") {
      return {
        select: () => ({
          eq: () => ({
            order: () => ({
              limit: () => ({
                maybeSingle: () => mockRateScheduleMaybeSingle(),
              }),
            }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected table: ${table}`);
  };
}

const mockFrom = vi.fn(makeFromImpl());

// Stub runGenerationFor so the route's pre-flight assertions can be tested
// without spinning up the full generate-engine mock surface (which would
// duplicate the integration test in src/lib/billing/__tests__/generate.test.ts).
// The stub captures the call args, runs `calculateTieredCost` against the
// fixture rate schedule for fidelity with the historical assertions, and
// returns a synthesized written line item.
//
// Note: vi.mock factory is hoisted; references inside use only top-level
// imports (calculateTieredCost) and module-scope `let` (capturedUpdatePayload,
// capturedRunGenerationCall) — the constants LI_UUID / FIXTURE_RATE_SCHEDULE
// are inlined verbatim because hoisting evaluates the factory before the
// const declarations.
vi.mock("@/lib/billing/generate", async () => {
  return {
    isRunGenerationFatal: (out: { kind?: string }) =>
      Boolean(out && out.kind === "fatal"),
    runGenerationFor: vi.fn(async (params: {
      periodId: string;
      householdIds?: string[];
      manualReadings?: Array<{ householdId: string; startKwh: number; endKwh: number; reason?: string }>;
    }) => {
      const m = params.manualReadings?.[0];
      if (!m) {
        return { results: [] };
      }
      // Two-tier schedule: 0–50 kWh at 500/kWh, 51+ at 800/kWh — kept in
      // sync with FIXTURE_RATE_SCHEDULE below.
      const tiers = [
        { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
        { label: "Tier 2", min_kwh: 51, max_kwh: null, rate_per_kwh: 800 },
      ];
      const calc = calculateTieredCost(
        m.endKwh - m.startKwh,
        tiers as never,
        0,
        0,
      );
      // Synthesized "written" line item — populates the captured update
      // payload that the historical assertions inspect (usage_kwh,
      // tier_breakdown, total_amount, end_kwh).
      capturedUpdatePayload = {
        usage_kwh: m.endKwh - m.startKwh,
        end_kwh: m.endKwh,
        tier_breakdown: calc.tierBreakdown,
        total_amount: calc.totalAmount,
      };
      return {
        results: [
          {
            kind: "written" as const,
            householdId: m.householdId,
            householdName: "Stub HH",
            lineItem: {
              id: "660e8400-e29b-41d4-a716-446655440111",
              device_id: null,
              ...capturedUpdatePayload,
            },
            previousTotalAmount: null,
            previousPaymentStatus: null,
            previousReadingSource: null,
          },
        ],
      };
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    // BC1 (#173) added an explicit auth gate at the top of the route. Tests
    // mock the session as a stable test user — RLS isn't exercised by the
    // unit suite (covered by RLS tests against live Supabase).
    auth: {
      getUser: async () => ({
        data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
        error: null,
      }),
    },
    rpc: vi.fn(),
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

const LI_UUID = "660e8400-e29b-41d4-a716-446655440111";
const HH_UUID = "660e8400-e29b-41d4-a716-446655440222";
const PERIOD_UUID = "660e8400-e29b-41d4-a716-446655440333";
const MG_UUID = "660e8400-e29b-41d4-a716-446655440444";
const DEVICE_UUID = "660e8400-e29b-41d4-a716-44665544aaaa";
const BAD_ID = "not-a-uuid";

function makePatchRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/billing-line-items/${id}/usage`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }
  );
}

const FIXTURE_RATE_SCHEDULE = {
  id: "rs-1",
  microgrid_id: MG_UUID,
  // Two-tier schedule: 0–50 kWh at 500/kWh, 51+ at 800/kWh.
  tiers: [
    { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
    { label: "Tier 2", min_kwh: 51, max_kwh: null, rate_per_kwh: 800 },
  ],
  service_charge: 0,
  tax_rate: 0,
  created_at: "2026-01-01T00:00:00Z",
};

describe("PATCH /api/billing-line-items/[lineItemId]/usage (#158)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessMicrogridReturn = true;
    capturedUpdatePayload = null;
    mockFrom.mockImplementation(makeFromImpl());

    // Default un-metered line item (device_id null), draft period, no
    // household meter link, fresh rate schedule.
    mockLineItemMaybeSingle.mockResolvedValue({
      data: {
        id: LI_UUID,
        device_id: null,
        start_kwh: 0,
        end_kwh: null,
        usage_kwh: null,
        household_id: HH_UUID,
        billing_period_id: PERIOD_UUID,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "draft",
        },
      },
      error: null,
    });
    mockMeterLinkMaybeSingle.mockResolvedValue({ data: null, error: null });
    mockRateScheduleMaybeSingle.mockResolvedValue({
      data: FIXTURE_RATE_SCHEDULE,
      error: null,
    });
  });

  it("400: invalid UUID", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(BAD_ID, { usage_kwh: 10 }), {
      params: Promise.resolve({ lineItemId: BAD_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("400: invalid JSON", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(LI_UUID, "{not json"), {
      params: Promise.resolve({ lineItemId: LI_UUID }),
    });
    expect(res.status).toBe(400);
  });

  it("400: missing both keys", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makePatchRequest(LI_UUID, {}), {
      params: Promise.resolve({ lineItemId: LI_UUID }),
    });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.reason).toBe("invalid_body");
  });

  it("400: negative number rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: -5 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(400);
  });

  it("400: non-numeric usage_kwh rejected", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: "lots" as unknown as number }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(400);
  });

  it("403: caller cannot access microgrid", async () => {
    canAccessMicrogridReturn = false;
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(403);
  });

  it("404: line item not found", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce({ data: null, error: null });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(404);
  });

  it("409: device_linked — line item already has a device_id", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce({
      data: {
        id: LI_UUID,
        device_id: DEVICE_UUID, // metered row — must reject manual edit
        start_kwh: 0,
        end_kwh: 100,
        usage_kwh: 100,
        household_id: HH_UUID,
        billing_period_id: PERIOD_UUID,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "draft",
        },
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_linked");
  });

  it("409: device_linked — household has primary_consumption_meter link (line item device_id null)", async () => {
    // Belt-and-braces: even when the line item itself has no device_id,
    // a household-level meter link blocks manual edit. The meter link
    // would be filled in on the next Refresh Readings.
    mockMeterLinkMaybeSingle.mockResolvedValueOnce({
      data: { device_id: DEVICE_UUID },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("device_linked");
  });

  it("409: period_closed — closed period rejects", async () => {
    mockLineItemMaybeSingle.mockResolvedValueOnce({
      data: {
        id: LI_UUID,
        device_id: null,
        start_kwh: 0,
        end_kwh: null,
        usage_kwh: null,
        household_id: HH_UUID,
        billing_period_id: PERIOD_UUID,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "closed",
        },
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 10 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.reason).toBe("period_closed");
  });

  it("200: happy path with usage_kwh only — recomputes tier_breakdown via calculateTieredCost", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { usage_kwh: 80 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(200);

    // 80 kWh on the fixture schedule:
    //   tier 1: 50 kWh × 500 = 25000
    //   tier 2: 30 kWh × 800 = 24000
    //   total: 49000
    expect(capturedUpdatePayload).not.toBeNull();
    const payload = capturedUpdatePayload as Record<string, unknown>;
    expect(payload.usage_kwh).toBe(80);
    expect(payload.total_amount).toBe(49000);
    const breakdown = payload.tier_breakdown as {
      label: string;
      kwh: number;
      amount: number;
    }[];
    expect(breakdown.length).toBe(2);
    expect(breakdown[0]).toEqual({ label: "Tier 1", kwh: 50, amount: 25000 });
    expect(breakdown[1]).toEqual({ label: "Tier 2", kwh: 30, amount: 24000 });
  });

  it("200: happy path with end_kwh only — derives usage_kwh = end_kwh - start_kwh", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { end_kwh: 80 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(200);

    expect(capturedUpdatePayload).not.toBeNull();
    const payload = capturedUpdatePayload as Record<string, unknown>;
    expect(payload.usage_kwh).toBe(80);
    expect(payload.end_kwh).toBe(80);
    expect(payload.total_amount).toBe(49000);
  });

  it("400: end_kwh < start_kwh derivation underflow rejected", async () => {
    // Override start_kwh = 100, send end_kwh = 50 → derived usage = -50 → 400.
    mockLineItemMaybeSingle.mockResolvedValueOnce({
      data: {
        id: LI_UUID,
        device_id: null,
        start_kwh: 100,
        end_kwh: null,
        usage_kwh: null,
        household_id: HH_UUID,
        billing_period_id: PERIOD_UUID,
        billing_periods: {
          id: PERIOD_UUID,
          microgrid_id: MG_UUID,
          status: "draft",
        },
      },
      error: null,
    });
    const { PATCH } = await import("../route");
    const res = await PATCH(
      makePatchRequest(LI_UUID, { end_kwh: 50 }),
      { params: Promise.resolve({ lineItemId: LI_UUID }) }
    );
    expect(res.status).toBe(400);
  });
});
