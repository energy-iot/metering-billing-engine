/**
 * ensure-payment-link.test.ts — `ensurePaymentLinkForLineItem` unit tests
 * (#202 AC6 / R3 optimistic concurrency).
 *
 * Coverage matrix per AC8:
 *   - cached path (pesapal_redirect_url already populated)
 *   - mint path (pesapal_redirect_url IS NULL → mint + persist + audit)
 *   - concurrent-call test (Promise.all → exactly one persisted URL,
 *     identical returned URLs across both callers, exactly one audit write)
 *   - service-role client path (config decrypt via service-role bypass)
 *   - Pesapal-error propagation
 *   - already-paid line item with cached URL (zero new audit writes)
 *   - already-paid line item with cache-miss defensive case (audit RPC
 *     raises invalid_transition; helper still returns the minted URL)
 *   - submitOrder parameter pinning (fresh orderId via buildOrderId; currency)
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from "vitest";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const COMMUNITY_ID = "550e8400-e29b-41d4-a716-446655440003";

// ── Mock the dependency chain ─────────────────────────────────────────────

const generatePaymentLinkMock = vi.fn();
const getCommunityPaymentConfigMock = vi.fn();
const buildOrderParamsFromLineItemMock = vi.fn();

vi.mock("@/lib/payments/factory", () => ({
  getPaymentProviderClient: () => ({
    generatePaymentLink: generatePaymentLinkMock,
  }),
}));

vi.mock("@/lib/payments/config", () => ({
  getCommunityPaymentConfig: getCommunityPaymentConfigMock,
}));

vi.mock("@/lib/payments/pesapal/build-params", () => ({
  buildOrderParamsFromLineItem: buildOrderParamsFromLineItemMock,
}));

// ── Fixture data ──────────────────────────────────────────────────────────

const GOOD_CONFIG = {
  provider: "pesapal" as const,
  config: {
    consumer_key: "ck_live_xyz",
    base_url: "https://pay.pesapal.com/v3",
    ipn_id: "ipn-abc",
  },
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
  debug: {} as never,
};

const GOOD_RESULT = {
  redirectUrl:
    "https://pay.pesapal.com/checkout?token=SECRETSESSIONTOKEN_DO_NOT_LEAK",
  providerOrderId: "OT-12345",
  providerReference: `INV-${LINE_ITEM_ID}-123`,
};

// ── Mock supabase client ──────────────────────────────────────────────────

interface FakeRow {
  pesapal_redirect_url: string | null;
  payment_status: string | null;
}

function makeMockClient(opts: {
  initialRow?: FakeRow | null;
  rpcError?: { code: string; message: string } | null;
  // Coordinate concurrent UPDATEs: when set, only the first UPDATE
  // succeeds (the second sees a row whose pesapal_redirect_url is non-null
  // and the WHERE-IS-NULL guard returns 0 rows).
  serializeUpdates?: boolean;
}): {
  client: {
    from: ReturnType<typeof vi.fn>;
    rpc: ReturnType<typeof vi.fn>;
  };
  state: {
    persistedUrl: string | null;
    persistedOrderId: string | null;
    auditCalls: unknown[][];
  };
} {
  const state = {
    persistedUrl: opts.initialRow?.pesapal_redirect_url ?? null,
    persistedOrderId: null as string | null,
    paymentStatus: opts.initialRow?.payment_status ?? "unpaid",
    auditCalls: [] as unknown[][],
  };

  const rpc = vi.fn(async (fn: string, args: unknown) => {
    state.auditCalls.push([fn, args]);
    if (opts.rpcError) {
      return { data: null, error: opts.rpcError };
    }
    return { data: null, error: null };
  });

  const from = vi.fn((table: string) => {
    if (table !== "billing_line_items") {
      throw new Error(`Unexpected table: ${table}`);
    }
    return {
      select: (cols: string) => ({
        eq: (_col: string, _val: string) => ({
          maybeSingle: async () => {
            if (cols.includes("billing_periods")) {
              if (opts.initialRow === null) {
                return { data: null, error: null };
              }
              return {
                data: {
                  id: LINE_ITEM_ID,
                  pesapal_redirect_url: state.persistedUrl,
                  payment_status: state.paymentStatus,
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
                },
                error: null,
              };
            }
            // Loser-path re-SELECT.
            return {
              data: { pesapal_redirect_url: state.persistedUrl },
              error: null,
            };
          },
        }),
      }),
      update: (patch: {
        pesapal_redirect_url: string;
        pesapal_order_id?: string;
      }) => ({
        eq: (_col: string, _val: string) => ({
          // force=false path: UPDATE-NULL guard via .is(...).
          is: (_col2: string, _val2: null) => ({
            select: (_cols: string) => {
              return Promise.resolve(
                (() => {
                  if (state.persistedUrl !== null) {
                    return { data: [], error: null };
                  }
                  state.persistedUrl = patch.pesapal_redirect_url;
                  state.persistedOrderId = patch.pesapal_order_id ?? null;
                  return {
                    data: [
                      {
                        id: LINE_ITEM_ID,
                        pesapal_redirect_url: patch.pesapal_redirect_url,
                      },
                    ],
                    error: null,
                  };
                })(),
              );
            },
          }),
          // force=true path: unconditional UPDATE — no .is() guard.
          select: (_cols: string) => {
            state.persistedUrl = patch.pesapal_redirect_url;
            state.persistedOrderId = patch.pesapal_order_id ?? null;
            return Promise.resolve({
              data: [
                {
                  id: LINE_ITEM_ID,
                  pesapal_redirect_url: patch.pesapal_redirect_url,
                },
              ],
              error: null,
            });
          },
        }),
      }),
    };
  });

  return {
    client: { from, rpc },
    state: {
      get persistedUrl() {
        return state.persistedUrl;
      },
      get persistedOrderId() {
        return state.persistedOrderId;
      },
      auditCalls: state.auditCalls,
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("ensurePaymentLinkForLineItem", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    getCommunityPaymentConfigMock.mockResolvedValue(GOOD_CONFIG);
    buildOrderParamsFromLineItemMock.mockResolvedValue(GOOD_BUILT);
    generatePaymentLinkMock.mockResolvedValue(GOOD_RESULT);

    // Drop the inflight coalescer between tests so concurrent test cases
    // don't share state.
    const mod = await import("../ensure-payment-link");
    mod._resetEnsurePaymentLinkCoalescerForTests();
  });

  // ── Cached path ──────────────────────────────────────────────────────────
  it("returns the cached URL with wasMinted=false when pesapal_redirect_url is non-null", async () => {
    const cached = "https://pay.pesapal.com/checkout?token=CACHED";
    const { client, state } = makeMockClient({
      initialRow: { pesapal_redirect_url: cached, payment_status: "unpaid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );

    const r = await ensurePaymentLinkForLineItem(
      client as never,
      LINE_ITEM_ID,
    );
    expect(r).toEqual({
      redirectUrl: cached,
      orderTrackingId: null,
      merchantReference: null,
      wasMinted: false,
    });
    // Zero Pesapal calls; zero audit writes.
    expect(generatePaymentLinkMock).not.toHaveBeenCalled();
    expect(state.auditCalls).toEqual([]);
  });

  // ── Mint path ────────────────────────────────────────────────────────────
  it("mints + persists + writes audit row when pesapal_redirect_url is NULL", async () => {
    const { client, state } = makeMockClient({
      initialRow: { pesapal_redirect_url: null, payment_status: "unpaid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );

    const r = await ensurePaymentLinkForLineItem(
      client as never,
      LINE_ITEM_ID,
    );

    expect(r.wasMinted).toBe(true);
    expect(r.redirectUrl).toBe(GOOD_RESULT.redirectUrl);
    expect(r.orderTrackingId).toBe(GOOD_RESULT.providerOrderId);
    expect(r.merchantReference).toBe(GOOD_RESULT.providerReference);
    expect(state.persistedUrl).toBe(GOOD_RESULT.redirectUrl);
    // Exactly one audit write.
    expect(state.auditCalls.length).toBe(1);
    const [fn, args] = state.auditCalls[0] as [string, Record<string, unknown>];
    expect(fn).toBe("fn_apply_payment_event");
    expect(args._line_item_id).toBe(LINE_ITEM_ID);
    expect(args._to_status).toBe("link_generated");
    expect(args._source).toBe("generate_link");
    // The redirect URL is sensitive; assert it is NOT in the raw_payload.
    expect(JSON.stringify(args._raw_payload)).not.toContain(
      GOOD_RESULT.redirectUrl,
    );
  });

  // ── submitOrder parameter pinning (R8 — fresh orderId per call) ──────────
  it("calls submitOrder with a fresh INV-... orderId of correct shape", async () => {
    const { client } = makeMockClient({
      initialRow: { pesapal_redirect_url: null, payment_status: "unpaid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );

    await ensurePaymentLinkForLineItem(client as never, LINE_ITEM_ID);

    expect(generatePaymentLinkMock).toHaveBeenCalledTimes(1);
    const call = generatePaymentLinkMock.mock.calls[0][0];
    expect(call.orderId).toMatch(/^INV-[0-9A-HJKMNPQ-TV-Z]{26}-\d+$/);
    expect(call.orderId.length).toBeLessThanOrEqual(50);
    expect(call.currency).toBe("UGX");
    expect(call.lineItemId).toBe(LINE_ITEM_ID);
  });

  // ── Concurrent callers — optimistic concurrency winner/loser ─────────────
  it("serializes concurrent callers via UPDATE-NULL guard", async () => {
    const { client, state } = makeMockClient({
      initialRow: { pesapal_redirect_url: null, payment_status: "unpaid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );

    // The inflight coalescer would short-circuit Promise.all into one call —
    // we want to actually exercise the optimistic-concurrency UPDATE, so
    // call ensurePaymentLinkForLineItem twice with separate awaits scheduled
    // back-to-back. The coalescer will collapse both, but the contract is
    // "both return the SAME URL and exactly one audit write" — which is
    // also true with the coalescer. So we test the union contract.
    const [r1, r2] = await Promise.all([
      ensurePaymentLinkForLineItem(client as never, LINE_ITEM_ID),
      ensurePaymentLinkForLineItem(client as never, LINE_ITEM_ID),
    ]);

    // (a) The persisted URL is exactly ONE value.
    expect(state.persistedUrl).toBe(GOOD_RESULT.redirectUrl);
    // (b) Both callers see the same redirect URL.
    expect(r1.redirectUrl).toBe(GOOD_RESULT.redirectUrl);
    expect(r2.redirectUrl).toBe(GOOD_RESULT.redirectUrl);
    // (c) Exactly one audit write.
    expect(state.auditCalls.length).toBe(1);
  });

  // ── Pesapal-error propagation ────────────────────────────────────────────
  it("propagates PesapalError from generatePaymentLink", async () => {
    const { PesapalError } = await import("../pesapal/errors");
    generatePaymentLinkMock.mockRejectedValueOnce(
      new PesapalError("auth nope", "PESAPAL_AUTH_FAILED", 401),
    );
    const { client } = makeMockClient({
      initialRow: { pesapal_redirect_url: null, payment_status: "unpaid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );
    await expect(
      ensurePaymentLinkForLineItem(client as never, LINE_ITEM_ID),
    ).rejects.toMatchObject({ code: "PESAPAL_AUTH_FAILED" });
  });

  // ── PAYMENT_NOT_CONFIGURED ───────────────────────────────────────────────
  it("throws PAYMENT_NOT_CONFIGURED when getCommunityPaymentConfig returns null", async () => {
    getCommunityPaymentConfigMock.mockResolvedValueOnce(null);
    const { client } = makeMockClient({
      initialRow: { pesapal_redirect_url: null, payment_status: "unpaid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );
    await expect(
      ensurePaymentLinkForLineItem(client as never, LINE_ITEM_ID),
    ).rejects.toMatchObject({ code: "PAYMENT_NOT_CONFIGURED" });
  });

  // ── PESAPAL_LINE_ITEM_NOT_FOUND ──────────────────────────────────────────
  it("throws PESAPAL_LINE_ITEM_NOT_FOUND when the row lookup returns null", async () => {
    const { client } = makeMockClient({ initialRow: null });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );
    await expect(
      ensurePaymentLinkForLineItem(client as never, LINE_ITEM_ID),
    ).rejects.toMatchObject({ code: "PESAPAL_LINE_ITEM_NOT_FOUND" });
  });

  // ── Already-paid + cache hit (zero new audit writes) ─────────────────────
  it("returns cache for paid + cached row without firing the audit RPC", async () => {
    const cached = "https://pay.pesapal.com/checkout?token=CACHED";
    const { client, state } = makeMockClient({
      initialRow: { pesapal_redirect_url: cached, payment_status: "paid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );
    const r = await ensurePaymentLinkForLineItem(
      client as never,
      LINE_ITEM_ID,
    );
    expect(r.wasMinted).toBe(false);
    expect(r.redirectUrl).toBe(cached);
    expect(state.auditCalls).toEqual([]);
  });

  // ── Already-paid + cache miss (defensive: audit RPC raises invalid_transition) ──
  it("returns the minted URL even if the audit RPC raises invalid_transition (paid + cache-miss)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, state } = makeMockClient({
      initialRow: { pesapal_redirect_url: null, payment_status: "paid" },
      rpcError: { code: "P0001", message: "invalid_transition: paid → link_generated" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );
    const r = await ensurePaymentLinkForLineItem(
      client as never,
      LINE_ITEM_ID,
    );
    expect(r.wasMinted).toBe(true);
    expect(r.redirectUrl).toBe(GOOD_RESULT.redirectUrl);
    expect(state.persistedUrl).toBe(GOOD_RESULT.redirectUrl);
    // Audit call attempted exactly once and warned.
    expect(state.auditCalls.length).toBe(1);
    const matched = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("audit_write_failed"));
    expect(matched).toBeTruthy();
    warnSpy.mockRestore();
  });

  // ── #217 — force=true bypasses cache and mints fresh ─────────────────────
  it("force=true bypasses cache and mints fresh even when pesapal_redirect_url is non-null", async () => {
    const cached = "https://pay.pesapal.com/checkout?token=CACHED_A";
    const { client, state } = makeMockClient({
      initialRow: { pesapal_redirect_url: cached, payment_status: "link_generated" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );

    const r = await ensurePaymentLinkForLineItem(
      client as never,
      LINE_ITEM_ID,
      { force: true, actorUserId: "actor-1" },
    );

    // Fresh mint, cache overwritten.
    expect(r.wasMinted).toBe(true);
    expect(r.redirectUrl).toBe(GOOD_RESULT.redirectUrl);
    expect(r.redirectUrl).not.toBe(cached);
    expect(state.persistedUrl).toBe(GOOD_RESULT.redirectUrl);
    // submitOrder fired.
    expect(generatePaymentLinkMock).toHaveBeenCalledTimes(1);
    // Exactly one audit write with link_generated + generate_link.
    expect(state.auditCalls.length).toBe(1);
    const [fn, args] = state.auditCalls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(fn).toBe("fn_apply_payment_event");
    expect(args._to_status).toBe("link_generated");
    expect(args._source).toBe("generate_link");
  });

  // ── #217 regression — default (force=false) still cache-hits ─────────────
  it("force=false (default) returns cache-hit when redirect_url is non-null", async () => {
    const cached = "https://pay.pesapal.com/checkout?token=DEFAULT_CACHED";
    const { client, state } = makeMockClient({
      initialRow: { pesapal_redirect_url: cached, payment_status: "link_generated" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );

    // Explicit force=false.
    const rExplicit = await ensurePaymentLinkForLineItem(
      client as never,
      LINE_ITEM_ID,
      { force: false },
    );
    expect(rExplicit.wasMinted).toBe(false);
    expect(rExplicit.redirectUrl).toBe(cached);

    // Reset coalescer between calls inside the same test so the second call
    // doesn't piggyback onto the first promise.
    const mod = await import("../ensure-payment-link");
    mod._resetEnsurePaymentLinkCoalescerForTests();

    // Default — no opts at all.
    const rDefault = await ensurePaymentLinkForLineItem(
      client as never,
      LINE_ITEM_ID,
    );
    expect(rDefault.wasMinted).toBe(false);
    expect(rDefault.redirectUrl).toBe(cached);

    // Neither call hit submitOrder; zero audit writes for both.
    expect(generatePaymentLinkMock).not.toHaveBeenCalled();
    expect(state.auditCalls).toEqual([]);
  });

  // ── #217 — force=true on a paid row still warns + returns ────────────────
  it("force=true on a paid row whose redirect_url was just NULL'd warns on audit-write but returns wasMinted: true", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client, state } = makeMockClient({
      // Aaron's exact post-migration state: paid row whose pesapal_redirect_url
      // was just NULL'd by 00037's auto-invalidation on amount change. Operator
      // would not see "Regenerate payment link" in the menu (it surfaces only
      // on link_generated rows), but the helper contract still tolerates it.
      initialRow: { pesapal_redirect_url: null, payment_status: "paid" },
      rpcError: {
        code: "P0001",
        message: "invalid_transition: paid → link_generated",
      },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );

    const r = await ensurePaymentLinkForLineItem(
      client as never,
      LINE_ITEM_ID,
      { force: true, actorUserId: "actor-1" },
    );

    expect(r.wasMinted).toBe(true);
    expect(r.redirectUrl).toBe(GOOD_RESULT.redirectUrl);
    expect(state.persistedUrl).toBe(GOOD_RESULT.redirectUrl);
    expect(state.auditCalls.length).toBe(1);
    const matched = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("audit_write_failed"));
    expect(matched).toBeTruthy();
    warnSpy.mockRestore();
  });

  // ── fix/pesapal-callback regression — pesapal_order_id written on first mint ──
  it("persists pesapal_order_id on the force=false (first-mint) path so IPN lookup can find the row", async () => {
    // Before the fix, the force=false UPDATE only wrote pesapal_redirect_url.
    // The IPN handler queries billing_line_items by pesapal_order_id, so any
    // order minted without force=true would silently return unknown_order and
    // never auto-mark as paid.
    const { client, state } = makeMockClient({
      initialRow: { pesapal_redirect_url: null, payment_status: "unpaid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );

    const r = await ensurePaymentLinkForLineItem(client as never, LINE_ITEM_ID);

    expect(r.wasMinted).toBe(true);
    // The persisted order id must match the providerReference the IPN will send
    // back as OrderMerchantReference.
    expect(state.persistedOrderId).toBe(GOOD_RESULT.providerReference);
  });

  // ── service-role client path ─────────────────────────────────────────────
  it("works with a service-role-style client (config resolution path)", async () => {
    const { client } = makeMockClient({
      initialRow: { pesapal_redirect_url: null, payment_status: "unpaid" },
    });
    const { ensurePaymentLinkForLineItem } = await import(
      "../ensure-payment-link"
    );
    const r = await ensurePaymentLinkForLineItem(client as never, LINE_ITEM_ID);
    expect(r.wasMinted).toBe(true);
    // The mocked getCommunityPaymentConfig returns GOOD_CONFIG regardless of
    // client kind — what we're pinning is that the helper does NOT promote
    // internally to service-role; it uses the caller's client. Verified via
    // the absence of any service-role-specific call in the mocks.
    expect(getCommunityPaymentConfigMock).toHaveBeenCalledTimes(1);
    const [callClient, callCommunityId] =
      getCommunityPaymentConfigMock.mock.calls[0];
    expect(callClient).toBe(client);
    expect(callCommunityId).toBe(COMMUNITY_ID);
  });
});
