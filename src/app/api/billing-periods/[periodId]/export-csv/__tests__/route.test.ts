/**
 * GET /api/billing-periods/[periodId]/export-csv — route tests (#229).
 *
 * Coverage:
 *   - 400 bad UUID
 *   - 401 unauthenticated
 *   - 404 period missing / RLS-hidden
 *   - 403 cross-org (defense-in-depth helper toggle)
 *   - 200 happy path: text/csv content-type, sanitized filename, BOM prefix,
 *     Cache-Control: no-store
 *   - 200 on draft period
 *   - 200 empty period (no line items) → header-only CSV
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const PERIOD_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440003";

// ── Mocks ────────────────────────────────────────────────────────────────────

let canAccessMicrogridReturn = true;

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

type FromState = {
  billing_periods: { data: unknown; error: unknown };
  microgrids: { data: unknown; error: unknown };
  rate_schedules: { data: unknown; error: unknown };
  billing_line_items: { data: unknown; error: unknown };
  household_devices: { data: unknown; error: unknown };
};

const sessionFromState: FromState = {
  billing_periods: { data: null, error: null },
  microgrids: { data: null, error: null },
  rate_schedules: { data: null, error: null },
  billing_line_items: { data: null, error: null },
  household_devices: { data: null, error: null },
};

const serviceFromState: FromState = {
  billing_periods: { data: null, error: null },
  microgrids: { data: null, error: null },
  rate_schedules: { data: null, error: null },
  billing_line_items: { data: null, error: null },
  household_devices: { data: null, error: null },
};

const mockGetUser = vi.fn().mockResolvedValue({
  data: { user: { id: "actor-user-1" } },
  error: null,
});

function makeSessionFromImpl(table: string) {
  if (table === "billing_periods") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(sessionFromState.billing_periods),
        }),
      }),
    };
  }
  throw new Error(`Unexpected session-table: ${table}`);
}

function makeServiceFromImpl(table: string) {
  if (table === "microgrids") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(serviceFromState.microgrids),
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
              maybeSingle: () =>
                Promise.resolve(serviceFromState.rate_schedules),
            }),
          }),
        }),
      }),
    };
  }
  if (table === "billing_line_items") {
    return {
      select: () => ({
        eq: () => Promise.resolve(serviceFromState.billing_line_items),
      }),
    };
  }
  if (table === "household_devices") {
    return {
      select: () => ({
        in: () => ({
          eq: () => Promise.resolve(serviceFromState.household_devices),
        }),
      }),
    };
  }
  throw new Error(`Unexpected service-table: ${table}`);
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: makeSessionFromImpl,
    auth: { getUser: mockGetUser },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: makeServiceFromImpl,
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/billing-periods/${PERIOD_ID}/export-csv`,
    { method: "GET" },
  );
}

function periodRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PERIOD_ID,
    microgrid_id: MICROGRID_ID,
    start_date: "2026-04-01",
    end_date: "2026-04-30",
    status: "closed",
    ...overrides,
  };
}

function microgridRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MICROGRID_ID,
    community_id: COMMUNITY_ID,
    name: "Sezibwa",
    currency: "UGX",
    address_line1: null,
    address_line2: null,
    address_city: null,
    address_region: null,
    address_country: null,
    address_postal_code: null,
    lat: null,
    lng: null,
    created_at: "2026-01-01T00:00:00Z",
    ems_type: "openems_b2b",
    ems_backend_url: null,
    ems_aws_region: null,
    ems_aws_access_key_id: null,
    ems_known_edge_ids: [],
    ems_last_discover_at: null,
    ems_last_discover_count: null,
    ems_last_discover_error: null,
    ems_last_discover_status: null,
    communities: {
      id: COMMUNITY_ID,
      invoice_config: { tax: { show_section: true, rate_pct: 18 } },
    },
    ...overrides,
  };
}

const RATE_SCHEDULE_ROW = {
  tiers: [{ label: "Tier 1", min_kwh: 1, max_kwh: null, rate_per_kwh: 500 }],
  service_charge: 0,
  tax_rate: 0.18,
  created_at: "2026-04-01",
};

const LINE_ITEM_ROW = {
  id: "00000000-0000-0000-0000-000000000001",
  invoice_number: "NFE-2026-00001",
  created_at: "2026-04-30T08:30:00Z",
  start_kwh: 0,
  end_kwh: 100,
  usage_kwh: 100,
  tier_breakdown: [{ label: "Tier 1", kwh: 100, amount: 50000 }],
  total_amount: 50000,
  payment_status: "unpaid",
  paid_at: null,
  household_id: "hh-1",
  households: {
    id: "hh-1",
    display_name: "Aaron",
    account_number: "A-1",
    meter_serial: "MS-1",
    meter_type: "Smart Submeter",
    customer_type: "residential",
    unit_label: null,
    address_line1: null,
    address_line2: null,
    address_city: null,
    address_country: null,
    primary_phone: "+256700000001",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  canAccessMicrogridReturn = true;
  sessionFromState.billing_periods = { data: periodRow(), error: null };
  serviceFromState.microgrids = { data: microgridRow(), error: null };
  serviceFromState.rate_schedules = { data: RATE_SCHEDULE_ROW, error: null };
  serviceFromState.billing_line_items = {
    data: [LINE_ITEM_ROW],
    error: null,
  };
  serviceFromState.household_devices = {
    data: [
      {
        household_id: "hh-1",
        devices: { openems_component_id: "meter0" },
      },
    ],
    error: null,
  };
  mockGetUser.mockResolvedValue({
    data: { user: { id: "actor-user-1" } },
    error: null,
  });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/billing-periods/[periodId]/export-csv", () => {
  it("400: invalid UUID in path", async () => {
    const { GET } = await import("../route");
    const req = new NextRequest(
      `http://localhost/api/billing-periods/not-a-uuid/export-csv`,
    );
    const res = await GET(req, {
      params: Promise.resolve({ periodId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("401: unauthenticated", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("404: period not found / RLS-hidden", async () => {
    sessionFromState.billing_periods = { data: null, error: null };
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("403: caller cannot access microgrid (defense-in-depth after row load)", async () => {
    canAccessMicrogridReturn = false;
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("forbidden");
  });

  it("200: happy path returns CSV with correct headers + sanitized filename", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="sezibwa-billing-period-2026-04-01-to-2026-04-30.csv"`,
    );
  });

  it("200: response body begins with the UTF-8 BOM (0xEF 0xBB 0xBF)", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(buf.slice(0, 3))).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("200: works on draft periods (operators preview pre-close)", async () => {
    sessionFromState.billing_periods = {
      data: periodRow({ status: "draft" }),
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
  });

  it("200 empty period → header-only CSV (no data rows) but tier columns present in header", async () => {
    serviceFromState.billing_line_items = { data: [], error: null };
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    // strip BOM, split on CRLF, drop trailing empty
    const stripped = body.startsWith("﻿") ? body.slice(1) : body;
    const lines = stripped.split("\r\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    expect(lines.length).toBe(1);
    // Header still has tier columns (Tier 1 kWh + Tier 1 UGX), so 18 + 2 = 20.
    expect(lines[0].split(",").length).toBe(18 + 2);
    expect(lines[0]).toContain("Tier 1 kWh");
    expect(lines[0]).toContain("Tier 1 UGX");
  });

  it("filename sanitization: microgrid name with special chars → lowered + dashed", async () => {
    serviceFromState.microgrids = {
      data: microgridRow({ name: "NFE — Pilot #1" }),
      error: null,
    };
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="nfe-pilot-1-billing-period-2026-04-01-to-2026-04-30.csv"`,
    );
  });
});
