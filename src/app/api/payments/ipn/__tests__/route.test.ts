/**
 * /api/payments/ipn — Pesapal IPN webhook receiver tests (Phase B, #157).
 *
 * Coverage:
 *   1. POST + verify COMPLETED → fn_apply_payment_event called with paid.
 *   2. POST + verify FAILED → applied with failed.
 *   3. POST + verify REVERSED → applied with refunded.
 *   4. POST + verify PENDING → no-op (no RPC, ack 200).
 *   5. POST + unknown merchantReference → ack 200, no RPC.
 *   6. POST + getTransactionStatus throws → ack 200, RPC NOT called.
 *   7. GET (legacy query-string flow) → still wired.
 *   8. Missing ids → ack 200.
 *   9. RPC error path → ack 200, warn logged.
 *  10. fn_apply_payment_event called with source='ipn' and actor_user_id=null.
 *
 * The receiver MUST always return HTTP 200, regardless of internal state.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockGetAccessToken = vi.fn();
const mockGetTransactionStatus = vi.fn();
class MockPesapalClient {
  constructor() {
    /* noop */
  }
  getAccessToken = mockGetAccessToken;
  getTransactionStatus = mockGetTransactionStatus;
}

vi.mock("@/lib/payments/pesapal/client", () => ({
  PesapalClient: MockPesapalClient,
}));

vi.mock("@/lib/payments/config", () => ({
  parsePesapalConfig: (raw: unknown) =>
    raw as { consumer_key: string; base_url: string; ipn_id: string },
}));

const mockFrom = vi.fn();
const mockRpc = vi.fn();

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: mockFrom,
    rpc: mockRpc,
  }),
}));

// ── Fixture helpers ────────────────────────────────────────────────────────

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440003";
const MERCHANT_REF = "INV-ABCDEFGHJKMNPQRSTVWXYZ012-1700000000";
const ORDER_TRACKING_ID = "OT-12345-uuid";

function billingLineItemRow(payment_status = "link_generated") {
  return {
    id: LINE_ITEM_ID,
    payment_status,
    billing_period_id: "bp-1",
    billing_periods: {
      microgrid_id: MICROGRID_ID,
      microgrids: {
        community_id: COMMUNITY_ID,
      },
    },
  };
}

function communityRow() {
  return {
    id: COMMUNITY_ID,
    payment_provider: "pesapal",
    payment_provider_config: {
      consumer_key: "ck_x",
      base_url: "https://pay.pesapal.com/v3",
      ipn_id: "ipn-abc",
    },
  };
}

function setupSupabaseHappyPath() {
  let scopeCalled = 0;
  let communityCalled = 0;
  mockFrom.mockImplementation((table: string) => {
    if (table === "billing_line_items") {
      scopeCalled++;
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: billingLineItemRow(), error: null }),
          }),
        }),
      };
    }
    if (table === "communities") {
      communityCalled++;
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: communityRow(), error: null }),
          }),
        }),
      };
    }
    throw new Error(`Unexpected from(${table}) — calls: scope=${scopeCalled} community=${communityCalled}`);
  });

  // First .rpc call is fn_get_community_payment_secret; second is fn_apply_payment_event.
  mockRpc.mockImplementation((fn: string) => {
    if (fn === "fn_get_community_payment_secret") {
      return Promise.resolve({ data: "decrypted_secret_value", error: null });
    }
    if (fn === "fn_apply_payment_event") {
      return Promise.resolve({ data: null, error: null });
    }
    throw new Error(`Unexpected rpc: ${fn}`);
  });
}

function makePostReq(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/payments/ipn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makeGetReq(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/payments/ipn?${query}`, {
    method: "GET",
  });
}

// ── beforeEach ─────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAccessToken.mockResolvedValue("fake-token");
  mockGetTransactionStatus.mockResolvedValue({
    payment_status_description: "COMPLETED",
    amount: 12500,
    currency: "UGX",
    payment_method: "MPESA",
    confirmation_code: "MPX1234",
    merchant_reference: MERCHANT_REF,
  });
  setupSupabaseHappyPath();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe("POST /api/payments/ipn (Phase B)", () => {
  it("(1) COMPLETED → applies 'paid' via fn_apply_payment_event with source='ipn'", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostReq({
        OrderTrackingId: ORDER_TRACKING_ID,
        OrderMerchantReference: MERCHANT_REF,
        OrderNotificationType: "IPNCHANGE",
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true });

    // verify path called
    expect(mockGetAccessToken).toHaveBeenCalledTimes(1);
    expect(mockGetTransactionStatus).toHaveBeenCalledTimes(1);
    expect(mockGetTransactionStatus.mock.calls[0][1]).toBe(ORDER_TRACKING_ID);

    // RPC called: fn_get_community_payment_secret then fn_apply_payment_event
    const applyCall = mockRpc.mock.calls.find(
      (c) => c[0] === "fn_apply_payment_event",
    );
    expect(applyCall).toBeTruthy();
    const args = applyCall![1];
    expect(args._line_item_id).toBe(LINE_ITEM_ID);
    expect(args._to_status).toBe("paid");
    expect(args._source).toBe("ipn");
    expect(args._actor_user_id).toBeNull();
    expect(args._raw_payload.order_tracking_id).toBe(ORDER_TRACKING_ID);
    expect(args._raw_payload.merchant_reference).toBe(MERCHANT_REF);
  });

  it("(2) FAILED → applies 'failed'", async () => {
    mockGetTransactionStatus.mockResolvedValueOnce({
      payment_status_description: "FAILED",
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePostReq({ OrderTrackingId: ORDER_TRACKING_ID, OrderMerchantReference: MERCHANT_REF }),
    );
    expect(res.status).toBe(200);

    const apply = mockRpc.mock.calls.find(
      (c) => c[0] === "fn_apply_payment_event",
    );
    expect(apply![1]._to_status).toBe("failed");
  });

  it("(3) REVERSED → applies 'refunded'", async () => {
    mockGetTransactionStatus.mockResolvedValueOnce({
      payment_status_description: "REVERSED",
    });

    const { POST } = await import("../route");
    const res = await POST(
      makePostReq({ OrderTrackingId: ORDER_TRACKING_ID, OrderMerchantReference: MERCHANT_REF }),
    );
    expect(res.status).toBe(200);

    const apply = mockRpc.mock.calls.find(
      (c) => c[0] === "fn_apply_payment_event",
    );
    expect(apply![1]._to_status).toBe("refunded");
  });

  it("(4) PENDING → no apply RPC, ack 200", async () => {
    mockGetTransactionStatus.mockResolvedValueOnce({
      payment_status_description: "PENDING",
    });

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(
      makePostReq({ OrderTrackingId: ORDER_TRACKING_ID, OrderMerchantReference: MERCHANT_REF }),
    );
    expect(res.status).toBe(200);

    expect(
      mockRpc.mock.calls.find((c) => c[0] === "fn_apply_payment_event"),
    ).toBeUndefined();

    const matched = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('"status":"noop"'));
    expect(matched).toBeTruthy();

    infoSpy.mockRestore();
  });

  it("(5) unknown merchantReference → 200 ack, no verify, no apply RPC", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "billing_line_items") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => Promise.resolve({ data: null, error: null }),
            }),
          }),
        };
      }
      throw new Error(`unexpected from(${table})`);
    });

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(
      makePostReq({
        OrderTrackingId: ORDER_TRACKING_ID,
        OrderMerchantReference: "INV-DOES-NOT-EXIST",
      }),
    );
    expect(res.status).toBe(200);

    expect(mockGetAccessToken).not.toHaveBeenCalled();
    expect(mockGetTransactionStatus).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();

    const matched = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("unknown_order"));
    expect(matched).toBeTruthy();

    infoSpy.mockRestore();
  });

  it("(6) getTransactionStatus throws (Pesapal unreachable) → ack 200, no apply RPC", async () => {
    mockGetTransactionStatus.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(
      makePostReq({ OrderTrackingId: ORDER_TRACKING_ID, OrderMerchantReference: MERCHANT_REF }),
    );
    expect(res.status).toBe(200);

    expect(
      mockRpc.mock.calls.find((c) => c[0] === "fn_apply_payment_event"),
    ).toBeUndefined();

    const matched = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("verify_failed"));
    expect(matched).toBeTruthy();

    warnSpy.mockRestore();
  });

  it("(8) missing ids → ack 200, no DB activity", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(makePostReq({}));
    expect(res.status).toBe(200);

    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();

    const matched = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("missing_ids"));
    expect(matched).toBeTruthy();

    infoSpy.mockRestore();
  });

  it("(9) fn_apply_payment_event RPC error → ack 200 + warn logged", async () => {
    mockRpc.mockImplementation((fn: string) => {
      if (fn === "fn_get_community_payment_secret") {
        return Promise.resolve({ data: "secret", error: null });
      }
      if (fn === "fn_apply_payment_event") {
        return Promise.resolve({
          data: null,
          error: {
            code: "P0001",
            message: "invalid_transition: refunded -> paid via ipn",
          },
        });
      }
      throw new Error("unexpected rpc");
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(
      makePostReq({ OrderTrackingId: ORDER_TRACKING_ID, OrderMerchantReference: MERCHANT_REF }),
    );
    expect(res.status).toBe(200);

    const matched = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("rpc_failed"));
    expect(matched).toBeTruthy();

    warnSpy.mockRestore();
  });

  it("(10) idempotent re-delivery: RPC always called with source='ipn', _actor_user_id=null", async () => {
    const { POST } = await import("../route");

    // First delivery
    let res = await POST(
      makePostReq({ OrderTrackingId: ORDER_TRACKING_ID, OrderMerchantReference: MERCHANT_REF }),
    );
    expect(res.status).toBe(200);

    // Re-delivery within seconds — fn_apply_payment_event handles dedup at SQL
    // layer, but the route still invokes it.
    res = await POST(
      makePostReq({ OrderTrackingId: ORDER_TRACKING_ID, OrderMerchantReference: MERCHANT_REF }),
    );
    expect(res.status).toBe(200);

    const applyCalls = mockRpc.mock.calls.filter(
      (c) => c[0] === "fn_apply_payment_event",
    );
    expect(applyCalls.length).toBe(2);
    for (const c of applyCalls) {
      expect(c[1]._source).toBe("ipn");
      expect(c[1]._actor_user_id).toBeNull();
    }
  });
});

describe("GET /api/payments/ipn (Phase B legacy flow)", () => {
  it("(7) GET with query params resolves and applies the transition", async () => {
    const { GET } = await import("../route");
    const res = await GET(
      makeGetReq(
        `OrderTrackingId=${encodeURIComponent(ORDER_TRACKING_ID)}&OrderMerchantReference=${encodeURIComponent(MERCHANT_REF)}`,
      ),
    );
    expect(res.status).toBe(200);

    const applyCall = mockRpc.mock.calls.find(
      (c) => c[0] === "fn_apply_payment_event",
    );
    expect(applyCall).toBeTruthy();
    expect(applyCall![1]._source).toBe("ipn");
  });
});
