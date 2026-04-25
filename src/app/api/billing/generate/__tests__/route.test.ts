/**
 * POST /api/billing/generate — Refresh Readings tests (#158).
 *
 * Coverage focus: the LEFT-join shape change introduced for un-metered
 * (manual-billing) households. Specifically:
 *   - Un-metered households now appear in the result set with an empty
 *     `household_devices` array. The route must skip the OpenEMS query for
 *     them but STILL insert a `billing_line_items` row with null device_id,
 *     null end_kwh, null usage_kwh, [] tier_breakdown, total_amount=0.
 *   - Metered households produce identical line items to pre-#158
 *     (regression: same start_kwh, end_kwh, usage_kwh, tier_breakdown,
 *     total_amount given the same OpenEMS reading).
 *
 * Note on mocking strategy: the route is heavily Supabase-chained. We
 * stub each from(table) entry-point and capture the row payload passed
 * to insert(). That gives us a per-row assertion surface against the spec.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ─────────────────────────────────────────────────────────────────

const mockPeriodSingle = vi.fn();
const mockRateScheduleMaybeSingle = vi.fn();
const mockHouseholdsResult = vi.fn();
const mockPriorPeriods = vi.fn();
const mockPriorItems = vi.fn();
let capturedDeleteFilter: { period_id?: string } = {};
let capturedInsertRows: Record<string, unknown>[] | null = null;
const mockGetReadings = vi.fn();

const mockFrom = vi.fn((table: string) => {
  if (table === "billing_periods") {
    return {
      select: (cols: string) => ({
        eq: (col: string, val: string) => ({
          single: () => mockPeriodSingle(),
          // The "list prior periods" path:
          lte: () => ({
            neq: () => ({
              order: () => mockPriorPeriods(),
            }),
          }),
          // Caught by the closer:
          _meta: { table, cols, col, val },
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
  if (table === "households") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => mockHouseholdsResult(),
        }),
      }),
    };
  }
  if (table === "billing_line_items") {
    return {
      select: () => ({
        in: () => ({
          in: () => ({
            not: () => mockPriorItems(),
          }),
        }),
      }),
      delete: () => ({
        eq: (_col: string, val: string) => {
          capturedDeleteFilter = { period_id: val };
          return Promise.resolve({ error: null });
        },
      }),
      insert: (rows: Record<string, unknown> | Record<string, unknown>[]) => {
        capturedInsertRows = Array.isArray(rows) ? rows : [rows];
        return Promise.resolve({ error: null });
      },
    };
  }
  throw new Error(`Unexpected table: ${table}`);
});

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

vi.mock("@/lib/openems/config", () => ({
  getMicrogridEmsConfig: async () => ({
    backendUrl: "https://example.test",
    authStrategy: "basic",
    auth: { username: "u", password: "p" },
  }),
}));

vi.mock("@/lib/openems", () => ({
  createOpenEmsClient: () => ({ getReadings: mockGetReadings }),
  OpenEmsError: class OpenEmsError extends Error {
    code = "test_error";
    statusCode = 500;
  },
}));

// ── Fixtures ───────────────────────────────────────────────────────────────

const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";
const MG_ID = "660e8400-e29b-41d4-a716-446655442000";
const RATE_SCHEDULE = {
  id: "rs-1",
  microgrid_id: MG_ID,
  tiers: [
    { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
    { label: "Tier 2", min_kwh: 51, max_kwh: null, rate_per_kwh: 800 },
  ],
  service_charge: 0,
  tax_rate: 0,
};

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/billing/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/billing/generate (#158 LEFT join + manual-billing rows)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedInsertRows = null;
    capturedDeleteFilter = {};

    mockPeriodSingle.mockResolvedValue({
      data: {
        id: PERIOD_ID,
        microgrid_id: MG_ID,
        start_date: "2026-04-01",
        end_date: "2026-04-30",
        status: "draft",
      },
      error: null,
    });
    mockRateScheduleMaybeSingle.mockResolvedValue({
      data: RATE_SCHEDULE,
      error: null,
    });
    mockPriorPeriods.mockResolvedValue({ data: [], error: null });
    mockPriorItems.mockResolvedValue({ data: [], error: null });
    mockGetReadings.mockResolvedValue([]);
  });

  it("inserts an un-metered placeholder row when a household has no primary_consumption_meter (#158)", async () => {
    // LEFT-join shape: household_devices array is empty for un-metered.
    mockHouseholdsResult.mockResolvedValue({
      data: [
        {
          id: "hh-unmetered",
          display_name: "Manual Family",
          household_devices: [],
        },
      ],
      error: null,
    });

    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);

    expect(capturedDeleteFilter.period_id).toBe(PERIOD_ID);
    expect(capturedInsertRows).not.toBeNull();
    expect(capturedInsertRows).toHaveLength(1);
    const row = (capturedInsertRows as Record<string, unknown>[])[0];
    // Manual-billing placeholder shape from AC-5:
    //   device_id null, start_kwh 0, end_kwh null, usage_kwh null,
    //   tier_breakdown [], total_amount 0.
    expect(row).toMatchObject({
      billing_period_id: PERIOD_ID,
      household_id: "hh-unmetered",
      device_id: null,
      start_kwh: 0,
      end_kwh: null,
      usage_kwh: null,
      total_amount: 0,
    });
    expect((row as Record<string, unknown>).tier_breakdown).toEqual([]);
  });

  it("regression: metered household produces identical line item shape to pre-#158", async () => {
    // The metered fixture mirrors the production-pinned period
    // (912c684e-7db1-4543-b02e-cd6d35cad46c) shape: one household with a
    // valid primary_consumption_meter device + edge.
    mockHouseholdsResult.mockResolvedValue({
      data: [
        {
          id: "hh-metered",
          display_name: "Metered Family",
          household_devices: [
            {
              role: "primary_consumption_meter",
              devices: {
                id: "dev-1",
                openems_component_id: "meter1",
                edges: { openems_edge_id: "edge0" },
              },
            },
          ],
        },
      ],
      error: null,
    });
    mockGetReadings.mockResolvedValue([
      { deviceId: "dev-1", usageKwh: 80 },
    ]);

    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);

    expect(capturedInsertRows).toHaveLength(1);
    const row = (capturedInsertRows as Record<string, unknown>[])[0];
    expect(row).toMatchObject({
      billing_period_id: PERIOD_ID,
      household_id: "hh-metered",
      device_id: "dev-1",
      usage_kwh: 80,
      start_kwh: 0,
      end_kwh: 80, // start_kwh + usage_kwh
      total_amount: 49000, // 50 × 500 + 30 × 800
    });
    const breakdown = (row as Record<string, unknown>).tier_breakdown as {
      label: string;
      kwh: number;
      amount: number;
    }[];
    expect(breakdown).toEqual([
      { label: "Tier 1", kwh: 50, amount: 25000 },
      { label: "Tier 2", kwh: 30, amount: 24000 },
    ]);
  });

  it("inserts BOTH metered + un-metered rows in the same Refresh run (#158)", async () => {
    mockHouseholdsResult.mockResolvedValue({
      data: [
        {
          id: "hh-metered",
          display_name: "Metered Family",
          household_devices: [
            {
              role: "primary_consumption_meter",
              devices: {
                id: "dev-1",
                openems_component_id: "meter1",
                edges: { openems_edge_id: "edge0" },
              },
            },
          ],
        },
        {
          id: "hh-unmetered",
          display_name: "Manual Family",
          household_devices: [],
        },
      ],
      error: null,
    });
    mockGetReadings.mockResolvedValue([
      { deviceId: "dev-1", usageKwh: 80 },
    ]);

    const { POST } = await import("../route");
    const res = await POST(makePostRequest({ billingPeriodId: PERIOD_ID }));
    expect(res.status).toBe(200);

    expect(capturedInsertRows).toHaveLength(2);
    const byHousehold = new Map(
      (capturedInsertRows as Record<string, unknown>[]).map((r) => [
        r.household_id,
        r,
      ])
    );
    // Metered row preserved exactly.
    const metered = byHousehold.get("hh-metered");
    expect(metered).toBeDefined();
    expect(metered).toMatchObject({
      device_id: "dev-1",
      usage_kwh: 80,
      end_kwh: 80,
      total_amount: 49000,
    });
    // Un-metered placeholder.
    const unmetered = byHousehold.get("hh-unmetered");
    expect(unmetered).toBeDefined();
    expect(unmetered).toMatchObject({
      device_id: null,
      usage_kwh: null,
      end_kwh: null,
      total_amount: 0,
    });
  });
});
