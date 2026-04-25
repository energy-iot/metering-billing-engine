/**
 * PesapalClient.registerIpn unit tests (#121).
 *
 * Pins behavior:
 *   - POSTs to /api/URLSetup/RegisterIPN with the URL + notification type.
 *   - Returns the parsed `{ ipn_id, ... }` shape.
 *   - Throws `PESAPAL_REGISTER_IPN_FAILED` on non-2xx.
 *   - Throws `PESAPAL_REGISTER_IPN_FAILED` if the 200 response lacks `ipn_id`.
 *   - Throws `PESAPAL_UNREACHABLE` on network failure.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PesapalClient } from "../client";
import { PesapalError } from "../errors";

const BASE_URL = "https://pay.pesapal.com/v3";

function makeClient(): PesapalClient {
  return new PesapalClient({
    consumerKey: "ck",
    consumerSecret: "cs_long_enough",
    baseUrl: BASE_URL,
  });
}

describe("PesapalClient.registerIpn", () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");

  beforeEach(() => {
    fetchSpy.mockReset();
  });

  afterEach(() => {
    fetchSpy.mockReset();
  });

  it("POSTs to /api/URLSetup/RegisterIPN with url + ipn_notification_type", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: "https://app/api/payments/ipn",
          created_date: "2026-04-25",
          ipn_id: "ipn-xyz",
          notification_type: 1,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = makeClient();
    const out = await client.registerIpn(
      "fake-token",
      "https://app/api/payments/ipn",
      "POST",
    );
    expect(out.ipn_id).toBe("ipn-xyz");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toBe(`${BASE_URL}/api/URLSetup/RegisterIPN`);
    expect((init as RequestInit).method).toBe("POST");
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody).toEqual({
      url: "https://app/api/payments/ipn",
      ipn_notification_type: "POST",
    });
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer fake-token");
  });

  it("defaults to POST notification type when omitted", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          url: "https://app/api/payments/ipn",
          created_date: "2026-04-25",
          ipn_id: "ipn-default",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );

    const client = makeClient();
    await client.registerIpn("tok", "https://app/api/payments/ipn");
    const [, init] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody.ipn_notification_type).toBe("POST");
  });

  it("throws PESAPAL_REGISTER_IPN_FAILED on non-2xx", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("denied", {
        status: 401,
      }),
    );

    const client = makeClient();
    await expect(
      client.registerIpn("tok", "https://app/api/payments/ipn"),
    ).rejects.toMatchObject({
      code: "PESAPAL_REGISTER_IPN_FAILED",
    });
  });

  it("throws PESAPAL_REGISTER_IPN_FAILED when 200 but ipn_id is missing", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const client = makeClient();
    await expect(
      client.registerIpn("tok", "https://app/api/payments/ipn"),
    ).rejects.toBeInstanceOf(PesapalError);
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ipn_id: "" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    await expect(
      client.registerIpn("tok", "https://app/api/payments/ipn"),
    ).rejects.toMatchObject({ code: "PESAPAL_REGISTER_IPN_FAILED" });
  });

  it("throws PESAPAL_UNREACHABLE on network failure", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("connect ECONNREFUSED"));

    const client = makeClient();
    await expect(
      client.registerIpn("tok", "https://app/api/payments/ipn"),
    ).rejects.toMatchObject({ code: "PESAPAL_UNREACHABLE" });
  });
});
