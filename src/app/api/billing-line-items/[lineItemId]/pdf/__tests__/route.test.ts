/**
 * GET /api/billing-line-items/[lineItemId]/pdf — route tests (#203 PDF1b).
 *
 * Coverage per AC6 (refined 2026-04-29):
 *   - Happy path → 200 PDF stream + correct headers.
 *   - Forbidden (currentUserCanAccessMicrogrid → false) → 403.
 *   - Not-found (line item missing / RLS-hidden) → 404.
 *   - Unauthorized (no session) → 401.
 *   - Bad UUID → 400.
 *   - Ensure-link succeeds branch → 200, helper invoked exactly once.
 *   - Ensure-link fails branch → 422 with reason.
 *   - No-payment-provider branch → 200 PDF, paymentRedirectUrl=null,
 *     ensurePaymentLinkForLineItem NOT called.
 *   - Invoice number first-render branch → fn_next_invoice_number called +
 *     persisted via UPDATE.
 *   - Invoice number stability → second call uses persisted value, RPC
 *     NOT called again.
 *   - Idempotency: two consecutive calls invoke ensurePaymentLinkForLineItem
 *     at most once across both (cache hit on second).
 *
 * The renderer is mocked because route tests assert routing/auth behavior,
 * not visual layout — the renderer's own tests cover PDF correctness.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440003";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440004";

// ── Mocks ────────────────────────────────────────────────────────────────────

const ensurePaymentLinkMock = vi.fn();
const renderInvoicePdfMock = vi.fn();

let canAccessMicrogridReturn = true;

vi.mock("@/lib/payments/ensure-payment-link", () => ({
  ensurePaymentLinkForLineItem: ensurePaymentLinkMock,
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

vi.mock("@/lib/invoices/render", () => ({
  renderInvoicePdf: renderInvoicePdfMock,
}));

// Service-role mock (logo download path).
const serviceDownloadMock = vi.fn().mockResolvedValue({
  data: null,
  error: { message: "no logo configured" },
});

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    storage: {
      from: () => ({
        download: serviceDownloadMock,
      }),
    },
  }),
}));

// Tracked Supabase mock state.
type FromState = {
  // Per-table response shape.
  lineItem: { data: unknown; error: unknown };
  household_devices: { data: unknown; error: unknown };
  rate_schedules: { data: unknown; error: unknown };
  user_directory: { data: unknown; error: unknown };
};

const fromState: FromState = {
  lineItem: { data: null, error: null },
  household_devices: { data: null, error: null },
  rate_schedules: { data: null, error: null },
  user_directory: { data: null, error: null },
};

// Captured updates to billing_line_items so tests can assert the persist.
const capturedUpdates: { invoice_number?: string }[] = [];
let updateError: { code?: string; message: string } | null = null;
let rpcCalls: { fn: string; args: unknown }[] = [];
let rpcCounter = 1;

const mockGetUser = vi.fn().mockResolvedValue({
  data: { user: { id: "actor-user-1" } },
  error: null,
});

function makeFromImpl(table: string) {
  if (table === "billing_line_items") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(fromState.lineItem),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: () => ({
          is: () => {
            capturedUpdates.push(payload as { invoice_number: string });
            if (updateError) {
              const err = updateError;
              updateError = null; // surface only once
              return Promise.resolve({ data: null, error: err });
            }
            return Promise.resolve({ data: payload, error: null });
          },
        }),
      }),
    };
  }
  if (table === "household_devices") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            order: () => ({
              limit: () => Promise.resolve(fromState.household_devices),
            }),
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
              maybeSingle: () => Promise.resolve(fromState.rate_schedules),
            }),
          }),
        }),
      }),
    };
  }
  if (table === "user_directory") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(fromState.user_directory),
        }),
      }),
    };
  }
  // Re-fetch path: SELECT(invoice_number).eq(id).maybeSingle()
  throw new Error(`Unexpected table: ${table}`);
}

const mockFrom = vi.fn(makeFromImpl);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
    rpc: vi.fn(async (fn: string, args: unknown) => {
      rpcCalls.push({ fn, args });
      if (fn === "fn_next_invoice_number") {
        return { data: rpcCounter++, error: null };
      }
      return { data: null, error: null };
    }),
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/billing-line-items/${LINE_ITEM_ID}/pdf`,
    { method: "GET" },
  );
}

function lineItemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: LINE_ITEM_ID,
    created_at: "2026-04-22T08:30:00Z",
    device_id: null,
    end_kwh: 100,
    entered_at: "2026-04-22T08:30:00Z",
    entered_by_user_id: null,
    household_id: "hh-1",
    invoice_number: null,
    manual_reason: null,
    paid_at: null,
    paid_by_user_id: null,
    payment_failed_at: null,
    payment_notes: null,
    payment_refunded_at: null,
    payment_status: "unpaid",
    pesapal_order_id: null,
    pesapal_redirect_url: null,
    reading_source: "edge",
    start_kwh: 0,
    tier_breakdown: [{ label: "Tier 1", kwh: 100, amount: 50000 }],
    total_amount: 50000,
    usage_kwh: 100,
    billing_period_id: "bp-1",
    billing_periods: {
      id: "bp-1",
      microgrid_id: MICROGRID_ID,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      microgrids: {
        id: MICROGRID_ID,
        community_id: COMMUNITY_ID,
        currency: "UGX",
        communities: {
          id: COMMUNITY_ID,
          invoice_config: {},
          invoice_prefix: "NFE",
          name: "X",
          org_id: ORG_ID,
          payment_provider: "pesapal",
          payment_provider_config: { provider: "pesapal" },
          payment_provider_secret_encrypted: null,
          payment_last_configured_at: null,
          organizations: {
            id: ORG_ID,
            name: "Org",
            created_at: "2026-01-01",
          },
        },
      },
    },
    households: {
      id: "hh-1",
      account_number: null,
      address_city: null,
      address_country: null,
      address_line1: null,
      address_line2: null,
      address_postal_code: null,
      address_region: null,
      contact_email: null,
      created_at: "2026-01-01",
      customer_type: "residential",
      display_name: "Aaron",
      geography_notes: null,
      meter_serial: null,
      meter_type: "Smart Submeter",
      microgrid_id: MICROGRID_ID,
      primary_email: null,
      primary_phone: "+256",
      unit_label: null,
    },
    ...overrides,
  };
}

const RATE_SCHEDULE_ROW = {
  id: "rs-1",
  microgrid_id: MICROGRID_ID,
  service_charge: 0,
  service_charge_description: null,
  tax_rate: 0,
  tiers: [{ label: "Tier 1", min_kwh: 1, max_kwh: null, rate_per_kwh: 500 }],
  created_at: "2026-04-01",
};

beforeEach(() => {
  vi.clearAllMocks();
  canAccessMicrogridReturn = true;
  capturedUpdates.length = 0;
  rpcCalls = [];
  rpcCounter = 1;
  updateError = null;
  // Default: row visible, helper succeeds with mint result, renderer returns
  // a tiny PDF buffer.
  fromState.lineItem = { data: lineItemRow(), error: null };
  fromState.household_devices = { data: [], error: null };
  fromState.rate_schedules = { data: RATE_SCHEDULE_ROW, error: null };
  fromState.user_directory = { data: null, error: null };
  ensurePaymentLinkMock.mockResolvedValue({
    redirectUrl: "https://pay.pesapal.com/x",
    orderTrackingId: "OT-1",
    merchantReference: "M-1",
    wasMinted: true,
  });
  renderInvoicePdfMock.mockResolvedValue(
    Buffer.from("%PDF-1.4 stub for tests", "utf8"),
  );
  mockFrom.mockImplementation(makeFromImpl);
  mockGetUser.mockResolvedValue({
    data: { user: { id: "actor-user-1" } },
    error: null,
  });
  serviceDownloadMock.mockReset().mockResolvedValue({
    data: null,
    error: { message: "no logo configured" },
  });
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/billing-line-items/[lineItemId]/pdf", () => {
  it("400: invalid UUID in path", async () => {
    const { GET } = await import("../route");
    const req = new NextRequest(
      `http://localhost/api/billing-line-items/not-a-uuid/pdf`,
    );
    const res = await GET(req, {
      params: Promise.resolve({ lineItemId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
  });

  it("401: unauthenticated", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: null });
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("404: line item not found / RLS-hidden", async () => {
    fromState.lineItem = { data: null, error: null };
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("403: caller cannot access microgrid (defense-in-depth after row load)", async () => {
    canAccessMicrogridReturn = false;
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("forbidden");
  });

  it("200: happy path returns PDF stream with correct headers", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const cd = res.headers.get("Content-Disposition") ?? "";
    expect(cd).toMatch(/^attachment; filename="NFE-2026-\d{5}\.pdf"$/);
  });

  it("ensure-link succeeds → helper invoked once, paymentRedirectUrl threaded", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    expect(ensurePaymentLinkMock).toHaveBeenCalledTimes(1);
    // Renderer received a non-null /pay URL because provider IS configured.
    const renderInput = renderInvoicePdfMock.mock.calls[0][0];
    expect(renderInput.paymentRedirectUrl).toMatch(
      /\/api\/billing-line-items\/.+\/pay$/,
    );
  });

  it("ensure-link fails (Pesapal upstream) → 422 with reason surfaced", async () => {
    const { PaymentError } = await import("@/lib/payments/errors");
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PaymentError("Pesapal not reachable", "PESAPAL_UNREACHABLE", 503),
    );
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.reason).toBe("PESAPAL_UNREACHABLE");
    expect(body.error).toMatch(/payment link could not be created/i);
  });

  it("no-payment-provider configured → 200 PDF, helper NOT called, paymentRedirectUrl=null", async () => {
    const noProvider = lineItemRow();
    (
      noProvider.billing_periods.microgrids.communities as Record<string, unknown>
    ).payment_provider = null;
    (
      noProvider.billing_periods.microgrids.communities as Record<string, unknown>
    ).payment_provider_config = null;
    fromState.lineItem = { data: noProvider, error: null };

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    expect(ensurePaymentLinkMock).not.toHaveBeenCalled();
    const renderInput = renderInvoicePdfMock.mock.calls[0][0];
    expect(renderInput.paymentRedirectUrl).toBeNull();
  });

  it("invoice number first-render → fn_next_invoice_number called, persisted via UPDATE", async () => {
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    expect(rpcCalls).toContainEqual(
      expect.objectContaining({ fn: "fn_next_invoice_number" }),
    );
    // The route persists the formatted number.
    expect(capturedUpdates).toHaveLength(1);
    expect(capturedUpdates[0].invoice_number).toMatch(/^NFE-\d{4}-\d{5}$/);
  });

  it("invoice number stability → second call reuses persisted value, RPC NOT called", async () => {
    const persisted = lineItemRow({ invoice_number: "NFE-2026-00001" });
    fromState.lineItem = { data: persisted, error: null };

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    // Stability invariant: no fn_next_invoice_number call AND no UPDATE.
    expect(
      rpcCalls.filter((c) => c.fn === "fn_next_invoice_number"),
    ).toHaveLength(0);
    expect(capturedUpdates).toHaveLength(0);
    // Filename uses the persisted value.
    expect(res.headers.get("Content-Disposition")).toContain(
      "NFE-2026-00001.pdf",
    );
  });

  it("idempotency: two sequential calls invoke ensurePaymentLink at most once total (cached on 2nd)", async () => {
    // 1st call: cache miss, helper invoked.
    const { GET } = await import("../route");
    let res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);

    // Simulate that the line item now has the URL persisted (real
    // ensurePaymentLinkForLineItem writes pesapal_redirect_url). For the
    // 2nd call, swap the row to one with the URL populated; the route's
    // pre-flight check will see it and skip the helper.
    fromState.lineItem = {
      data: lineItemRow({
        invoice_number: "NFE-2026-00001",
        pesapal_redirect_url: "https://pay.pesapal.com/x",
      }),
      error: null,
    };

    res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    expect(ensurePaymentLinkMock).toHaveBeenCalledTimes(1);
  });

  it("invoice number race: 23505 unique violation → reload + use persisted value", async () => {
    // The route inserts via fn_next_invoice_number, then UPDATE…IS NULL.
    // Simulate the UPDATE failing with 23505 (concurrent winner) and the
    // re-SELECT returning the persisted value.
    updateError = { code: "23505", message: "unique_violation" };
    // Stub the second `from('billing_line_items').select('invoice_number').eq().maybeSingle()`
    // by patching the from impl on second call to return the persisted row.
    let lineItemSelectsCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "billing_line_items") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => {
                lineItemSelectsCount += 1;
                // 1st: scoped row with no invoice_number;
                // 2nd: re-SELECT after 23505 returns persisted value.
                if (lineItemSelectsCount === 1) {
                  return Promise.resolve(fromState.lineItem);
                }
                return Promise.resolve({
                  data: { invoice_number: "NFE-2026-99999" },
                  error: null,
                });
              },
            }),
          }),
          update: () => ({
            eq: () => ({
              is: () => {
                capturedUpdates.push({});
                return Promise.resolve({
                  data: null,
                  error: { code: "23505", message: "unique_violation" },
                });
              },
            }),
          }),
        };
      }
      return makeFromImpl(table);
    });

    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toContain(
      "NFE-2026-99999.pdf",
    );
  });
});
