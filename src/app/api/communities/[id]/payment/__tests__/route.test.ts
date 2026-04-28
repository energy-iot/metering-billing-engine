/**
 * PUT /api/communities/[id]/payment — unit tests (#119 AC-ROUTE-*, #196).
 *
 * Supabase + auth helpers + PesapalClient are mocked. Covers:
 *   (1) Happy path (new config) → 200, encrypts secret, writes all 4 columns
 *   (2) Happy path (reconfigure w/ blank secret) → secret-preserve skips encrypt
 *   (3) Permission: org_manager-of-parent-org → 200 (widened in #196)
 *   (4) Permission: cannot access org → 403
 *   (5) RLS-hidden / missing community → 404
 *   (6) Pesapal auth fail → 503 { reason: "auth_failed" }, no DB write
 *   (7) Pesapal unreachable → 503 { reason: "unreachable" }, no DB write
 *   (8) Malformed body → 400
 *   (9) First-configuration with blank secret → 400
 *  (10) base_url is server-derived from sandbox (NOT taken from body)
 *
 * Note: anon → 401 is enforced by `src/middleware.ts:57-64` for any /api/*
 * path; this unit test mounts the route handler directly so middleware does
 * not run. The DB-level NULL-for-anon defense-in-depth is covered by the
 * fn_get_community_payment_secret RLS test in `rls.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";

const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440010";
const ORG_ID = "550e8400-e29b-41d4-a716-446655440020";

// Vercel env var used by the route to derive the IPN callback URL.
const PRIOR_CALLBACK_URL = process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL;
process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL = "https://app.example.com";

afterAll(() => {
  if (PRIOR_CALLBACK_URL === undefined) {
    delete process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL;
  } else {
    process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL = PRIOR_CALLBACK_URL;
  }
});

// ─── Mocks ──────────────────────────────────────────────────────────────────

const getAccessTokenMock = vi.fn();
const registerIpnMock = vi.fn();

vi.mock("@/lib/payments/pesapal/client", async () => {
  const actual = await vi.importActual<
    typeof import("@/lib/payments/pesapal/client")
  >("@/lib/payments/pesapal/client");
  class PesapalClientMock {
    constructor(public cfg: unknown) {}
    getAccessToken = getAccessTokenMock;
    registerIpn = registerIpnMock;
  }
  return {
    ...actual,
    PesapalClient: PesapalClientMock,
  };
});

let canAccessOrgReturn = true;

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessOrg: async () => canAccessOrgReturn,
}));

// ─── Supabase mock — sequenced from() handlers, shared mockRpc ─────────────
//
// Route's from() sequence (success path, post-#121):
//   1. communities.select(... payment_provider_secret_encrypted).eq(id).maybeSingle()
//   2. communities.update(payload).eq(id)
//
// Plus: mockRpc is used for fn_get_community_payment_secret (preserve path)
// and fn_ems_encrypt_secret.

let communitySelectResp: { data: unknown; error: unknown } = {
  data: {
    id: COMMUNITY_ID,
    org_id: ORG_ID,
    payment_provider_secret_encrypted: null,
  },
  error: null,
};
let updateError: unknown = null;
let updatePayloadCapture: Record<string, unknown> | null = null;

const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockGetUser = vi
  .fn()
  .mockResolvedValue({ data: { user: { id: "actor-user-1" } } });

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    rpc: mockRpc,
    auth: { getUser: mockGetUser },
  }),
}));

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/communities/${COMMUNITY_ID}/payment`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

describe("PUT /api/communities/[id]/payment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    canAccessOrgReturn = true;
    communitySelectResp = {
      data: {
        id: COMMUNITY_ID,
        org_id: ORG_ID,
        payment_provider_secret_encrypted: null,
      },
      error: null,
    };
    updateError = null;
    updatePayloadCapture = null;
    process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL = "https://app.example.com";

    mockFrom.mockImplementation(() => {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve(communitySelectResp),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          updatePayloadCapture = payload;
          return {
            eq: () => Promise.resolve({ error: updateError }),
          };
        },
      };
    });

    mockRpc.mockImplementation((name: string) => {
      if (name === "fn_get_community_payment_secret") {
        return Promise.resolve({ data: "DECRYPTED_SECRET_VALUE_X", error: null });
      }
      if (name === "fn_ems_encrypt_secret") {
        return Promise.resolve({ data: "\\x0a0b0c0d", error: null });
      }
      return Promise.resolve({ data: null, error: { message: "unexpected rpc" } });
    });

    getAccessTokenMock.mockResolvedValue("fake-token");
    registerIpnMock.mockResolvedValue({
      url: "https://app.example.com/api/payments/ipn",
      created_date: "2026-04-25T00:00:00Z",
      ipn_id: "ipn-fresh-guid",
    });
  });

  // ─── (1) Happy path ────────────────────────────────────────────────────
  it("(1) happy path writes all 4 columns and returns 200 success", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: false },
        secret_access_key: "cs_live_verylongsecret",
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("success");
    expect(getAccessTokenMock).toHaveBeenCalledTimes(1);
    // #121: registerIpn called once, with the canonical callback URL.
    expect(registerIpnMock).toHaveBeenCalledTimes(1);
    expect(registerIpnMock).toHaveBeenCalledWith(
      "fake-token",
      "https://app.example.com/api/payments/ipn",
      "POST",
    );
    expect(updatePayloadCapture).toBeTruthy();
    const payload = updatePayloadCapture!;
    expect(payload.payment_provider).toBe("pesapal");
    expect(payload.payment_provider_config).toMatchObject({
      consumer_key: "ck_live_abc",
      base_url: "https://pay.pesapal.com/v3",
      sandbox: false,
      // #121: freshly-registered ipn_id persisted as a flat key.
      ipn_id: "ipn-fresh-guid",
    });
    expect(payload.payment_provider_secret_encrypted).toBe("\\x0a0b0c0d");
    expect(payload.payment_last_configured_at).toEqual(expect.any(String));
  });

  // ─── (2) Reconfigure with blank secret preserves ciphertext ────────────
  it("(2) secret-preserve: blank secret + existing ciphertext → no re-encrypt, column omitted", async () => {
    communitySelectResp = {
      data: {
        id: COMMUNITY_ID,
        org_id: ORG_ID,
        payment_provider_secret_encrypted: "\\xdeadbeef",
      },
      error: null,
    };

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: true },
        // no secret_access_key
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(200);
    // fn_get_community_payment_secret is the preserve-path decrypt.
    const rpcNames = mockRpc.mock.calls.map((c) => c[0]);
    expect(rpcNames).toContain("fn_get_community_payment_secret");
    expect(rpcNames).not.toContain("fn_ems_encrypt_secret");
    expect(updatePayloadCapture).toBeTruthy();
    expect(
      "payment_provider_secret_encrypted" in (updatePayloadCapture as object),
    ).toBe(false);
    // Server derived base_url from sandbox=true.
    expect(
      (
        updatePayloadCapture!.payment_provider_config as Record<
          string,
          unknown
        >
      ).base_url,
    ).toBe("https://cybqa.pesapal.com/pesapalv3");
    // #121: ipn_id is still re-registered + persisted on a secret-preserve.
    expect(registerIpnMock).toHaveBeenCalledTimes(1);
    expect(
      (
        updatePayloadCapture!.payment_provider_config as Record<
          string,
          unknown
        >
      ).ipn_id,
    ).toBe("ipn-fresh-guid");
  });

  // ─── (3) org_manager-of-parent-org → 200 (widened in #196) ─────────────
  it("(3) org_manager-of-parent-org (canAccessOrg=true) → 200 happy path", async () => {
    // Same setup as case (1) — canAccessOrgReturn defaults to true. This
    // mirrors the post-#196 behavior where any caller satisfying
    // currentUserCanAccessOrg can save the config (no separate super_admin
    // gate). The route never calls currentUserIsSuperAdmin anymore.
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: false },
        secret_access_key: "cs_live_verylongsecret",
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(200);
    expect(getAccessTokenMock).toHaveBeenCalledTimes(1);
    expect(updatePayloadCapture).toBeTruthy();
  });

  // ─── (4) cross-org → 403 ───────────────────────────────────────────────
  it("(4) currentUserCanAccessOrg=false → 403", async () => {
    canAccessOrgReturn = false;

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: false },
        secret_access_key: "cs_live_verylongsecret",
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(403);
    expect(updatePayloadCapture).toBeNull();
  });

  // ─── (5) RLS-hidden / missing community → 404 ─────────────────────────
  it("(5) community not found / RLS-hidden → 404", async () => {
    communitySelectResp = { data: null, error: null };

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: false },
        secret_access_key: "cs_live_verylongsecret",
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(404);
  });

  // ─── (6) Pesapal auth fail → 503 no write ─────────────────────────────
  it("(6) Pesapal auth failure → 503 auth_failed, no DB persist", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    getAccessTokenMock.mockRejectedValueOnce(
      new PesapalError("auth nope", "PESAPAL_AUTH_FAILED", 401),
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: false },
        secret_access_key: "cs_live_verylongsecret",
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("auth_failed");
    expect(updatePayloadCapture).toBeNull();
  });

  // ─── (7) Pesapal unreachable → 503 no write ───────────────────────────
  it("(7) Pesapal unreachable → 503 unreachable, no DB persist", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    getAccessTokenMock.mockRejectedValueOnce(
      new PesapalError("net down", "PESAPAL_UNREACHABLE", 503),
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: false },
        secret_access_key: "cs_live_verylongsecret",
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("unreachable");
    expect(updatePayloadCapture).toBeNull();
  });

  // ─── (8) Malformed body → 400 ─────────────────────────────────────────
  it("(8) malformed body → 400", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({ provider: "not-a-provider" }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(400);
  });

  // ─── (9) First configure with blank secret → 400 ──────────────────────
  it("(9) first configuration with blank secret → 400", async () => {
    // default communitySelectResp has payment_provider_secret_encrypted: null
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: false },
        // no secret
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(400);
    expect(getAccessTokenMock).not.toHaveBeenCalled();
  });

  // ─── (10) base_url is server-derived from sandbox ─────────────────────
  it("(10) base_url is server-derived (sandbox=true → cybqa host)", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        // Body sends bogus base_url — should be IGNORED by the server.
        config: {
          consumer_key: "ck_live_abc",
          sandbox: true,
          base_url: "https://evil.example.com/",
        } as unknown as Record<string, unknown>,
        secret_access_key: "cs_live_verylongsecret",
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(200);
    const stored = (updatePayloadCapture!.payment_provider_config as Record<
      string,
      unknown
    >).base_url;
    expect(stored).toBe("https://cybqa.pesapal.com/pesapalv3");
  });

  // ─── (11) #121 IPN registration failure → 503 register_ipn_failed ──────
  it("(11) IPN registration failure → 503 register_ipn_failed, no DB write", async () => {
    const { PesapalError } = await import("@/lib/payments/pesapal/errors");
    registerIpnMock.mockRejectedValueOnce(
      new PesapalError(
        "RegisterIPN returned 401",
        "PESAPAL_REGISTER_IPN_FAILED",
        502,
      ),
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        config: { consumer_key: "ck_live_abc", sandbox: false },
        secret_access_key: "cs_live_verylongsecret",
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("register_ipn_failed");
    expect(updatePayloadCapture).toBeNull();
    // Encrypt is gated on the success path — never called when IPN fails.
    const rpcNames = mockRpc.mock.calls.map((c) => c[0]);
    expect(rpcNames).not.toContain("fn_ems_encrypt_secret");
  });

  // ─── (12) #121 callback URL env var unset → 503 callback_url_unknown ───
  it("(12) NEXT_PUBLIC_PAYMENT_CALLBACK_URL unset → 503 callback_url_unknown", async () => {
    const prior = process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL;
    delete process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL;
    try {
      const { PUT } = await import("../route");
      const res = await PUT(
        makePutRequest({
          provider: "pesapal",
          config: { consumer_key: "ck_live_abc", sandbox: false },
          secret_access_key: "cs_live_verylongsecret",
        }),
        { params: Promise.resolve({ id: COMMUNITY_ID }) },
      );
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.reason).toBe("callback_url_unknown");
      expect(updatePayloadCapture).toBeNull();
      // registerIpn never called because the URL is unknown.
      expect(registerIpnMock).not.toHaveBeenCalled();
    } finally {
      process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL = prior;
    }
  });

  // ─── (13) #121 sandbox toggle replaces ipn_id ──────────────────────────
  //
  // Save & test always re-registers, so toggling sandbox produces a NEW GUID
  // and the PRIOR ipn_id (which belonged to the other Pesapal environment)
  // is overwritten — never preserved.
  it("(13) sandbox toggle: ipn_id is replaced with the freshly-registered GUID", async () => {
    // Existing config used to be sandbox=false with an old prod ipn_id.
    communitySelectResp = {
      data: {
        id: COMMUNITY_ID,
        org_id: ORG_ID,
        payment_provider_secret_encrypted: "\\xdeadbeef",
      },
      error: null,
    };
    registerIpnMock.mockResolvedValueOnce({
      url: "https://app.example.com/api/payments/ipn",
      created_date: "2026-04-25T00:00:00Z",
      ipn_id: "ipn-sandbox-new-guid",
    });

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        provider: "pesapal",
        // Toggle sandbox=true → new IPN must be registered with the
        // sandbox account; the old prod GUID would be invalid.
        config: { consumer_key: "ck_live_abc", sandbox: true },
      }),
      { params: Promise.resolve({ id: COMMUNITY_ID }) },
    );
    expect(res.status).toBe(200);
    const cfg = updatePayloadCapture!.payment_provider_config as Record<
      string,
      unknown
    >;
    expect(cfg.ipn_id).toBe("ipn-sandbox-new-guid");
    expect(cfg.sandbox).toBe(true);
    expect(cfg.base_url).toBe("https://cybqa.pesapal.com/pesapalv3");
  });
});
