/**
 * POST /api/billing-line-items/[lineItemId]/url — unit tests (#115 / refactored
 * for #202).
 *
 * Post-#202 the route is a thin wrapper around `ensurePaymentLinkForLineItem()`.
 * The route still owns: pre-flight scope query, permission gate, and
 * `mapPaymentError` → response envelope. The test suite mocks the helper to
 * exercise every branch of the mapping plus the new cache-hit shape (where
 * the helper returns `wasMinted: false` and `orderTrackingId/merchantReference`
 * as `null`).
 *
 * Covers the 8-case matrix from the original ticket plus the new R5 cache-hit
 * shape:
 *   (1) Mint path → 200 + { redirectUrl, orderTrackingId, merchantReference }
 *   (1b) Cache-hit path → 200 + { redirectUrl, orderTrackingId: null,
 *        merchantReference: null }
 *   (2) Not configured → 409 reason: "not_configured"
 *   (3) auth_failed → 503 reason: "auth_failed"
 *   (4) unreachable → 503 reason: "unreachable"
 *   (5) missing_contact → 400 reason: "missing_contact"
 *   (6) Unauthorized (cross-community) → 404 reason: "not_found" (avoids leak)
 *   (7) Line item not found → 404 reason: "not_found"
 *   (8) Log scrubber strips redirect URL
 *   (9) IPN not registered → 409 ipn_not_registered (post-#121)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440003";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const ensurePaymentLinkMock = vi.fn();
let canAccessMicrogridReturn = true;

vi.mock("@/lib/payments/ensure-payment-link", () => ({
  ensurePaymentLinkForLineItem: ensurePaymentLinkMock,
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

// Shared from-chain state for the single billing_line_items scope query.
let scopeResponse: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
const mockFrom = vi.fn();
const mockGetUser = vi
  .fn()
  .mockResolvedValue({ data: { user: { id: "actor-user-1" } } });

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
}));

function makeReq(): NextRequest {
  return new NextRequest(
    `http://localhost/api/billing-line-items/${LINE_ITEM_ID}/url`,
    { method: "POST" },
  );
}

function scopedRow() {
  return {
    id: LINE_ITEM_ID,
    billing_period_id: "bp-1",
    billing_periods: {
      id: "bp-1",
      microgrid_id: MICROGRID_ID,
      microgrids: {
        id: MICROGRID_ID,
        community_id: COMMUNITY_ID,
        currency: "UGX",
      },
    },
  };
}

const MINT_RESULT = {
  redirectUrl:
    "https://pay.pesapal.com/checkout?token=SECRETSESSIONTOKEN_DO_NOT_LEAK",
  orderTrackingId: "OT-12345",
  merchantReference: `INV-${LINE_ITEM_ID}-123`,
  wasMinted: true,
};

const CACHE_HIT_RESULT = {
  redirectUrl: "https://pay.pesapal.com/checkout?token=cached_value",
  orderTrackingId: null,
  merchantReference: null,
  wasMinted: false,
};

describe("POST /api/billing-line-items/[lineItemId]/url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessMicrogridReturn = true;
    scopeResponse = { data: scopedRow(), error: null };

    mockFrom.mockImplementation(() => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve(scopeResponse),
        }),
      }),
    }));

    ensurePaymentLinkMock.mockResolvedValue(MINT_RESULT);
  });

  // ─── (1) Mint path — original happy path ─────────────────────────────────
  it("(1) returns 200 with mint shape on success", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('"payment.generate_link"'),
    );
    expect(mockGetUser).toHaveBeenCalledTimes(1);

    const body = await res.json();
    expect(body).toEqual({
      redirectUrl: MINT_RESULT.redirectUrl,
      orderTrackingId: MINT_RESULT.orderTrackingId,
      merchantReference: MINT_RESULT.merchantReference,
    });

    // The helper was called with the resolved actor user id.
    expect(ensurePaymentLinkMock).toHaveBeenCalledTimes(1);
    const [_client, lineId, opts] = ensurePaymentLinkMock.mock.calls[0];
    expect(lineId).toBe(LINE_ITEM_ID);
    expect(opts.actorUserId).toBe("actor-user-1");

    infoSpy.mockRestore();
  });

  // ─── (1b) Cache-hit path — new R5 shape ──────────────────────────────────
  it("(1b) returns 200 with cache-hit shape (orderTrackingId: null, merchantReference: null)", async () => {
    ensurePaymentLinkMock.mockResolvedValueOnce(CACHE_HIT_RESULT);
    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      redirectUrl: CACHE_HIT_RESULT.redirectUrl,
      orderTrackingId: null,
      merchantReference: null,
    });
  });

  // ─── (2) Not configured ───────────────────────────────────────────────────
  it("(2) returns 409 not_configured when helper throws PAYMENT_NOT_CONFIGURED", async () => {
    const { PaymentError } = await import("@/lib/payments/errors");
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PaymentError(
        "No payment provider configured for this community.",
        "PAYMENT_NOT_CONFIGURED",
        409,
      ),
    );

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("not_configured");
  });

  // ─── (3) auth_failed ─────────────────────────────────────────────────────
  it("(3) returns 503 auth_failed when helper throws PESAPAL_AUTH_FAILED", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PesapalError("auth nope", "PESAPAL_AUTH_FAILED", 401),
    );

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("auth_failed");
  });

  // ─── (4) unreachable ─────────────────────────────────────────────────────
  it("(4) returns 503 unreachable when helper throws PESAPAL_UNREACHABLE", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PesapalError("net down", "PESAPAL_UNREACHABLE", 503),
    );

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("unreachable");
  });

  // ─── (5) missing_contact ─────────────────────────────────────────────────
  it("(5) returns 400 missing_contact when helper throws PESAPAL_MISSING_CONTACT", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PesapalError(
        'Household "X" has neither primary_email nor primary_phone',
        "PESAPAL_MISSING_CONTACT",
        400,
      ),
    );

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("missing_contact");
  });

  // ─── (6) Unauthorized (cross-community) — avoids existence leak → 404 ────
  it("(6) returns 404 not_found when currentUserCanAccessMicrogrid is false", async () => {
    canAccessMicrogridReturn = false;

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("not_found");
    expect(ensurePaymentLinkMock).not.toHaveBeenCalled();
  });

  // ─── (7) Line item not found ─────────────────────────────────────────────
  it("(7) returns 404 not_found when the line-item scope row is RLS-hidden", async () => {
    scopeResponse = { data: null, error: null };

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("not_found");
    expect(ensurePaymentLinkMock).not.toHaveBeenCalled();
  });

  // ─── (8) Log scrubber strips redirect URL ────────────────────────────────
  it("(8) log payload never contains the redirect URL", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);

    const logCalls = infoSpy.mock.calls.map((args) => String(args[0]));
    const matching = logCalls.filter((s) =>
      s.includes('"payment.generate_link"'),
    );
    expect(matching.length).toBeGreaterThanOrEqual(1);

    const joined = matching.join("\n");
    expect(joined).not.toContain(MINT_RESULT.redirectUrl);
    expect(joined).not.toContain("SECRETSESSIONTOKEN_DO_NOT_LEAK");

    infoSpy.mockRestore();
  });

  // ─── (9) IPN not registered → 409 ipn_not_registered ─────────────────────
  it("(9) returns 409 ipn_not_registered when helper throws PAYMENT_IPN_NOT_REGISTERED", async () => {
    const { PaymentError } = await import("@/lib/payments/errors");
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PaymentError(
        "Pesapal config is missing ipn_id — open Community Payment settings and run Save & test connection to register the IPN URL with Pesapal.",
        "PAYMENT_IPN_NOT_REGISTERED",
        409,
      ),
    );

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("ipn_not_registered");
    expect(String(body.error)).toMatch(/IPN/i);
    expect(String(body.error)).toMatch(/Save & test/i);
  });
});
