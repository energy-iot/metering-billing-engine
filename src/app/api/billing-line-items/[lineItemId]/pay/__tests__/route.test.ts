/**
 * GET /api/billing-line-items/[lineItemId]/pay — unit tests (#202).
 *
 * Pins the AC8 status-code matrix:
 *   - 302 happy path (cached URL)
 *   - 302 mint path (helper returns wasMinted=true)
 *   - 404 PESAPAL_LINE_ITEM_NOT_FOUND
 *   - 409 PAYMENT_NOT_CONFIGURED
 *   - 502 any other PaymentError (e.g. PESAPAL_AUTH_FAILED)
 *   - 429 rate-limit exceeded (11th call within 60s)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";

const ensurePaymentLinkMock = vi.fn();

vi.mock("@/lib/payments/ensure-payment-link", () => ({
  ensurePaymentLinkForLineItem: ensurePaymentLinkMock,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({}),
}));

function makeReq(
  ip: string = "1.2.3.4",
  lineItemId: string = LINE_ITEM_ID,
): NextRequest {
  return new NextRequest(
    `http://localhost/api/billing-line-items/${lineItemId}/pay`,
    {
      method: "GET",
      headers: {
        "x-forwarded-for": ip,
      },
    },
  );
}

describe("GET /api/billing-line-items/[lineItemId]/pay", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset the in-memory rate limit between tests so each test starts with
    // a clean budget.
    const rl = await import("@/lib/rate-limit/in-memory");
    rl._resetRateLimitStoreForTests();
    // Note: the helper itself is mocked above, so its inflight coalescer
    // (an internal implementation detail of the real module) does not need
    // to be reset here.
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── 302 happy / cached ──────────────────────────────────────────────────
  it("(302 cached) redirects to the cached URL when helper returns wasMinted=false", async () => {
    ensurePaymentLinkMock.mockResolvedValueOnce({
      redirectUrl: "https://pay.pesapal.com/checkout?token=CACHED",
      orderTrackingId: null,
      merchantReference: null,
      wasMinted: false,
    });
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://pay.pesapal.com/checkout?token=CACHED",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // ── 302 mint path ───────────────────────────────────────────────────────
  it("(302 mint) redirects to the freshly minted URL when wasMinted=true", async () => {
    ensurePaymentLinkMock.mockResolvedValueOnce({
      redirectUrl: "https://pay.pesapal.com/checkout?token=FRESH",
      orderTrackingId: "OT-1",
      merchantReference: "INV-...",
      wasMinted: true,
    });
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://pay.pesapal.com/checkout?token=FRESH",
    );
  });

  // ── 404 line item not found ─────────────────────────────────────────────
  it("(404) renders not-found HTML when helper throws PESAPAL_LINE_ITEM_NOT_FOUND", async () => {
    const { PesapalError } = await import(
      "@/lib/payments/pesapal/errors"
    );
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PesapalError(
        "Billing line item ... not found",
        "PESAPAL_LINE_ITEM_NOT_FOUND",
        404,
      ),
    );
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toMatch(/not available/i);
  });

  // ── 409 community has no payment provider ───────────────────────────────
  it("(409) renders not-configured HTML when helper throws PAYMENT_NOT_CONFIGURED", async () => {
    const { PaymentError } = await import("@/lib/payments/errors");
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PaymentError(
        "No payment provider configured for this community.",
        "PAYMENT_NOT_CONFIGURED",
        409,
      ),
    );
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toMatch(/not configured/i);
  });

  // ── 502 any other PesapalError ──────────────────────────────────────────
  it("(502) renders generic-failure HTML when helper throws any other PesapalError", async () => {
    const { PesapalError } = await import(
      "@/lib/payments/pesapal/errors"
    );
    ensurePaymentLinkMock.mockRejectedValueOnce(
      new PesapalError("auth nope", "PESAPAL_AUTH_FAILED", 401),
    );
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).toMatch(/could not be retrieved/i);
  });

  it("(502) maps generic non-PaymentError throws to 502 (no leakage)", async () => {
    ensurePaymentLinkMock.mockRejectedValueOnce(new Error("kaboom"));
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(502);
    const body = await res.text();
    expect(body).not.toMatch(/kaboom/);
  });

  // ── 429 rate-limit exceeded ─────────────────────────────────────────────
  it("(429) returns Retry-After when 11th call within 60s window", async () => {
    ensurePaymentLinkMock.mockResolvedValue({
      redirectUrl: "https://pay.pesapal.com/checkout?token=ok",
      orderTrackingId: null,
      merchantReference: null,
      wasMinted: false,
    });
    const { GET } = await import("../route");

    for (let i = 0; i < 10; i++) {
      const r = await GET(makeReq("9.9.9.9"), {
        params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
      });
      expect(r.status).toBe(302);
    }
    const r11 = await GET(makeReq("9.9.9.9"), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(r11.status).toBe(429);
    expect(r11.headers.get("retry-after")).toBeTruthy();
    expect(Number(r11.headers.get("retry-after"))).toBeLessThanOrEqual(60);
  });

  // ── 400 bad UUID ────────────────────────────────────────────────────────
  it("(400) rejects a non-UUID lineItemId without invoking the helper", async () => {
    const { GET } = await import("../route");
    const req = makeReq("1.2.3.4", "not-a-uuid");
    const res = await GET(req, {
      params: Promise.resolve({ lineItemId: "not-a-uuid" }),
    });
    expect(res.status).toBe(400);
    expect(ensurePaymentLinkMock).not.toHaveBeenCalled();
  });

  // ── Audit log scrubs the redirect URL ───────────────────────────────────
  it("does NOT log the Pesapal redirect URL (scrubbed)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    ensurePaymentLinkMock.mockResolvedValueOnce({
      redirectUrl: "https://pay.pesapal.com/checkout?token=DO_NOT_LEAK_THIS",
      orderTrackingId: null,
      merchantReference: null,
      wasMinted: false,
    });
    const { GET } = await import("../route");
    const res = await GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(302);

    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    const matching = logs.filter((s) => s.includes("payment.pay_redirect"));
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const joined = matching.join("\n");
    expect(joined).not.toContain("DO_NOT_LEAK_THIS");

    infoSpy.mockRestore();
  });

  // ── Backward-compat regression for #223 ─────────────────────────────────
  // The route was kept exactly as-is when #223 introduced the /p/<slug>
  // indirection. Bills already in customer WhatsApp threads use this long
  // URL, so removing or breaking this route is a hard NEVER. This test
  // pins the happy-path 302 behavior at the level of an external caller.
  it("(#223 backward-compat) route is NOT deleted and 302s correctly for legacy long URLs", async () => {
    ensurePaymentLinkMock.mockResolvedValueOnce({
      redirectUrl: "https://pay.pesapal.com/checkout?token=LEGACY",
      orderTrackingId: null,
      merchantReference: null,
      wasMinted: false,
    });
    const routeModule = await import("../route");
    // Sanity: the GET export exists (the route file was not deleted).
    expect(typeof routeModule.GET).toBe("function");
    const res = await routeModule.GET(makeReq(), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      "https://pay.pesapal.com/checkout?token=LEGACY",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  // ── IPv4 truncation in audit log ────────────────────────────────────────
  it("truncates IPv4 to /24 in audit log (last octet zeroed)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    ensurePaymentLinkMock.mockResolvedValueOnce({
      redirectUrl: "https://pay.pesapal.com/checkout?token=ok",
      orderTrackingId: null,
      merchantReference: null,
      wasMinted: false,
    });
    const { GET } = await import("../route");
    const res = await GET(makeReq("203.0.113.42"), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(302);

    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    const matching = logs.filter((s) => s.includes("payment.pay_redirect"));
    const joined = matching.join("\n");
    expect(joined).toContain("203.0.113.0");
    expect(joined).not.toContain("203.0.113.42");

    infoSpy.mockRestore();
  });
});
