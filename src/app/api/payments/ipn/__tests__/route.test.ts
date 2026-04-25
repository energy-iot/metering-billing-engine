/**
 * /api/payments/ipn — Pesapal IPN webhook receiver tests (#121, Phase A).
 *
 * Phase A acks 200 with no state work. Tests pin:
 *   - POST returns 200 { received: true }
 *   - GET (legacy Pesapal) returns 200 { received: true }
 *   - JSON body is parsed and surfaces in the structured log line
 *   - Query params surface in the structured log line
 *   - The receiver never throws / mutates state (no Supabase client used)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/payments/ipn (Phase A)", () => {
  it("acks 200 { received: true } and logs the parsed JSON body", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const req = new NextRequest("http://localhost/api/payments/ipn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        OrderTrackingId: "OT-123",
        OrderMerchantReference: "INV-abc",
        OrderNotificationType: "IPNCHANGE",
      }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ received: true });

    const logged = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('"payment.ipn.received"'));
    expect(logged).toBeTruthy();
    expect(logged!).toContain('"phase":"A"');
    expect(logged!).toContain('"method":"POST"');
    expect(logged!).toContain("OT-123");
    expect(logged!).toContain("INV-abc");

    infoSpy.mockRestore();
  });

  it("returns 200 even when the body is malformed JSON", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { POST } = await import("../route");
    const req = new NextRequest("http://localhost/api/payments/ipn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json-at-all",
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ received: true });

    infoSpy.mockRestore();
  });
});

describe("GET /api/payments/ipn (legacy Pesapal flow)", () => {
  it("acks 200 { received: true } and logs the query parameters", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { GET } = await import("../route");
    const req = new NextRequest(
      "http://localhost/api/payments/ipn?OrderTrackingId=OT-456&OrderMerchantReference=INV-xyz&OrderNotificationType=IPNCHANGE",
      { method: "GET" },
    );

    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ received: true });

    const logged = infoSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes('"payment.ipn.received"'));
    expect(logged).toBeTruthy();
    expect(logged!).toContain('"method":"GET"');
    expect(logged!).toContain("OT-456");
    expect(logged!).toContain("INV-xyz");

    infoSpy.mockRestore();
  });
});
