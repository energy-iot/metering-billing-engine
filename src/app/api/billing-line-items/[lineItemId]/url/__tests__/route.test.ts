/**
 * POST /api/billing-line-items/[lineItemId]/url — unit tests (#115).
 *
 * Covers the 8-case matrix from the ticket:
 *   (1) Happy path → 200 + { redirectUrl, orderTrackingId, merchantReference }
 *   (2) Not configured → 409 reason: "not_configured"
 *   (3) auth_failed → 503 reason: "auth_failed"
 *   (4) unreachable → 503 reason: "unreachable"
 *   (5) missing_contact → 400 reason: "missing_contact"
 *   (6) Unauthorized (cross-community) → 404 reason: "not_found" (avoids leak)
 *   (7) Line item not found → 404 reason: "not_found"
 *   (8) Log scrubber strips secret/token/URL
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440003";

// ─── Mocks ──────────────────────────────────────────────────────────────────

const generatePaymentLinkMock = vi.fn();
const getCommunityPaymentConfigMock = vi.fn();
const buildOrderParamsFromLineItemMock = vi.fn();
let canAccessMicrogridReturn = true;

vi.mock("@/lib/payments", async () => {
  const actual = await vi.importActual<typeof import("@/lib/payments")>(
    "@/lib/payments",
  );
  return {
    ...actual,
    getPaymentProviderClient: () => ({
      generatePaymentLink: generatePaymentLinkMock,
    }),
  };
});

vi.mock("@/lib/payments/config", () => ({
  getCommunityPaymentConfig: getCommunityPaymentConfigMock,
}));

vi.mock("@/lib/payments/pesapal/build-params", () => ({
  buildOrderParamsFromLineItem: buildOrderParamsFromLineItemMock,
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

const GOOD_CONFIG = {
  provider: "pesapal" as const,
  config: {
    consumer_key: "ck_live_xyz",
    base_url: "https://pay.pesapal.com/v3",
    ipn_id: "ipn-abc",
  },
  // MIN_SECRET_LENGTH = 6; keep this long enough to be scrubbed.
  secret: "cs_live_verylongsecretkey_dontlogme",
};

const GOOD_BUILT = {
  amount: 12500,
  description: "Utility bill for Mar 1, 2026 – Mar 31, 2026",
  billingAddress: {
    email_address: "alice@example.com",
    phone_number: "+256700000001",
    first_name: "Alice",
    last_name: "Mukasa",
  },
  debug: {
    lineItem: { id: LINE_ITEM_ID, total_amount: 12500 },
    period: {
      id: "bp-1",
      microgrid_id: MICROGRID_ID,
      start_date: "2026-03-01",
      end_date: "2026-03-31",
    },
    household: {
      id: "household-A",
      display_name: "Alice Mukasa",
      primary_email: "alice@example.com",
      primary_phone: "+256700000001",
    },
    dateRange: "Mar 1, 2026 – Mar 31, 2026",
  },
};

const GOOD_RESULT = {
  redirectUrl:
    "https://pay.pesapal.com/checkout?token=SECRETSESSIONTOKEN_DO_NOT_LEAK",
  providerOrderId: "OT-12345",
  providerReference: `INV-${LINE_ITEM_ID}-123`,
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
          single: () => Promise.resolve(scopeResponse),
        }),
      }),
    }));

    getCommunityPaymentConfigMock.mockResolvedValue(GOOD_CONFIG);
    buildOrderParamsFromLineItemMock.mockResolvedValue(GOOD_BUILT);
    generatePaymentLinkMock.mockResolvedValue(GOOD_RESULT);
  });

  // ─── (1) Happy path ───────────────────────────────────────────────────────
  it("(1) returns 200 with redirectUrl/orderTrackingId/merchantReference on success", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);

    // Log emits synchronously before the response is consumed.
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('"payment.generate_link"'));
    // Eager resolution: auth.getUser() called exactly once per request.
    expect(mockGetUser).toHaveBeenCalledTimes(1);

    const body = await res.json();
    expect(body).toEqual({
      redirectUrl: GOOD_RESULT.redirectUrl,
      orderTrackingId: GOOD_RESULT.providerOrderId,
      merchantReference: GOOD_RESULT.providerReference,
    });

    // Pesapal rejects reused ids — every call must generate a fresh orderId.
    const call = generatePaymentLinkMock.mock.calls[0][0];
    expect(call.orderId).toMatch(new RegExp(`^INV-${LINE_ITEM_ID}-\\d+$`));
    expect(call.currency).toBe("UGX");

    infoSpy.mockRestore();
  });

  // ─── (2) Not configured ────────────────────────────────────────────────────
  it("(2) returns 409 not_configured when getCommunityPaymentConfig returns null", async () => {
    getCommunityPaymentConfigMock.mockResolvedValueOnce(null);

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("not_configured");
  });

  // ─── (3) auth_failed ──────────────────────────────────────────────────────
  it("(3) returns 503 auth_failed when provider throws PESAPAL_AUTH_FAILED", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    generatePaymentLinkMock.mockRejectedValueOnce(
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

  // ─── (4) unreachable ──────────────────────────────────────────────────────
  it("(4) returns 503 unreachable when provider throws PESAPAL_UNREACHABLE", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    generatePaymentLinkMock.mockRejectedValueOnce(
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

  // ─── (5) missing_contact ──────────────────────────────────────────────────
  it("(5) returns 400 missing_contact when build-params throws PESAPAL_MISSING_CONTACT", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    buildOrderParamsFromLineItemMock.mockRejectedValueOnce(
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

  // ─── (6) Unauthorized (cross-community) — avoids existence leak → 404 ─────
  it("(6) returns 404 not_found when currentUserCanAccessMicrogrid is false", async () => {
    canAccessMicrogridReturn = false;

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("not_found");
  });

  // ─── (7) Line item not found ──────────────────────────────────────────────
  it("(7) returns 404 not_found when the line-item scope row is RLS-hidden", async () => {
    scopeResponse = { data: null, error: null };

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("not_found");
  });

  // ─── (8) Log scrubber strips secret + token + URL ─────────────────────────
  it("(8) log payload never contains secret, session token, or redirect URL", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const res = await POST(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);

    // The success path logs exactly one payment.generate_link event.
    const logCalls = infoSpy.mock.calls.map((args) => String(args[0]));
    const matching = logCalls.filter((s) =>
      s.includes('"payment.generate_link"'),
    );
    expect(matching.length).toBeGreaterThanOrEqual(1);

    const joined = matching.join("\n");
    expect(joined).not.toContain(GOOD_CONFIG.secret);
    expect(joined).not.toContain("SECRETSESSIONTOKEN_DO_NOT_LEAK");
    expect(joined).not.toContain(GOOD_RESULT.redirectUrl);

    infoSpy.mockRestore();
  });
});
