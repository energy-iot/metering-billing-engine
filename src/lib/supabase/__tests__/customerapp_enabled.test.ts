/**
 * customerapp_enabled.test.ts (#251)
 *
 * Per-org acceptance gate inside `resolveOrgFromToken`. After a token has
 * been successfully validated (lookup row + argon2 verify), the resolver
 * calls `customerapp_enabled_for_org(org_id)`; if the flag is FALSE the
 * caller sees a 403 with `reason: "customerapp_not_enabled"` — regardless
 * of how valid the token itself was.
 *
 * Failure-mode AC matrix (from #251 ticket body):
 *
 *   - Enabled org + valid token             → ok (no regression vs #255).
 *   - Disabled org + valid token            → 403 customerapp_not_enabled.
 *   - All-orgs-disabled default state       → 403 for every token (covered
 *                                              by the rpc-returns-FALSE case,
 *                                              since that's the DB default).
 *   - RPC error (network / DB hiccup)       → fail closed → 403 (don't open
 *                                              the gate on its own failure).
 *   - Flag flipped TRUE→FALSE mid-flight    → next request 403s (a new
 *                                              call always re-reads the flag;
 *                                              no caching).
 *   - Gate fires AFTER token validation     → an invalid token still 401s
 *                                              (not 403); we don't expose
 *                                              opt-in state to unauthed callers.
 *   - Gate calls the RPC with the org_id    → resolved from the token's row,
 *                                              not from any caller-supplied
 *                                              payload field.
 *
 * Architecture notes:
 *   - Tests run REAL argon2 (no mock) — matches the org_api_tokens.test.ts
 *     pattern. The whole suite stays under ~1s on Vercel-class hardware.
 *   - The Supabase service-role client is mocked at the module boundary
 *     with both `from(...)` (for the token lookup) AND `rpc(...)` (for
 *     the opt-in check). Tests control both via closure-captured state.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import argon2 from "argon2";

// ── Mock controls ──────────────────────────────────────────────────────────

type LookupRow = {
  id: string;
  org_id: string;
  name: string;
  token_hash: string;
  revoked_at: string | null;
};

let lookupResult: { data: LookupRow | null; error: { message: string } | null } = {
  data: null,
  error: null,
};
// Captures all updates so a fire-and-forget last_used_at write doesn't
// leak across tests.
let updatesByTable: Record<
  string,
  Array<{ payload: Record<string, unknown>; eqArgs?: [string, unknown] }>
> = {};
let updateError: { message: string; code?: string } | null = null;
// #251 — the acceptance-gate RPC stub. Default to opted-in so we have to
// flip it explicitly in the rejection-path tests below.
let customerappEnabledResult: {
  data: boolean | null;
  error: { message: string } | null;
} = { data: true, error: null };
// Captures the most-recent RPC invocation so tests can assert the gate
// was called with the resolved org_id, not some other UUID.
let lastRpcCall: { fn: string; args: Record<string, unknown> } | null = null;

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          is: () => ({
            maybeSingle: () => Promise.resolve(lookupResult),
          }),
        }),
      }),
      update: (payload: Record<string, unknown>) => ({
        eq: (column: string, value: unknown) => {
          if (!updatesByTable[table]) updatesByTable[table] = [];
          updatesByTable[table].push({ payload, eqArgs: [column, value] });
          return {
            then: (
              resolve: (v: { error: { message: string; code?: string } | null }) => void
            ) => {
              resolve({ error: updateError });
              return Promise.resolve({ error: updateError });
            },
          };
        },
      }),
    }),
    rpc: (fn: string, args: Record<string, unknown>) => {
      lastRpcCall = { fn, args };
      return Promise.resolve(customerappEnabledResult);
    },
  }),
}));

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/v1/billing-periods", {
    method: "POST",
    headers,
  });
}

// Real argon2 hash — generated once, reused across tests.
let KNOWN_SECRET: string;
let KNOWN_HASH: string;

beforeEach(async () => {
  vi.clearAllMocks();
  lookupResult = { data: null, error: null };
  updatesByTable = {};
  updateError = null;
  customerappEnabledResult = { data: true, error: null };
  lastRpcCall = null;
  if (!KNOWN_HASH) {
    KNOWN_SECRET = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
    KNOWN_HASH = await argon2.hash(KNOWN_SECRET, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }
});

afterAll(() => {
  delete process.env.MBE_TOKEN_ENV_PREFIX;
});

/** Convenience: stub a successful lookup so we can focus on the gate. */
function stubValidLookup(orgId = "org-uuid-1") {
  lookupResult = {
    data: {
      id: "token-uuid-1",
      org_id: orgId,
      name: "customerapp-prod-2026",
      token_hash: KNOWN_HASH,
      revoked_at: null,
    },
    error: null,
  };
}

describe("customerapp_enabled acceptance gate (#251)", () => {
  it("enabled org + valid token → ok", async () => {
    stubValidLookup("org-uuid-enabled");
    customerappEnabledResult = { data: true, error: null };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(true);
    expect(res).toMatchObject({
      ok: true,
      org_id: "org-uuid-enabled",
      token_name: "customerapp-prod-2026",
    });
  });

  it("disabled org + valid token → 403 customerapp_not_enabled", async () => {
    stubValidLookup("org-uuid-disabled");
    customerappEnabledResult = { data: false, error: null };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 403, reason: "customerapp_not_enabled" });
  });

  it("gate is called with the resolved org_id from the token row (not from any payload)", async () => {
    stubValidLookup("org-uuid-payload-cannot-influence-this");
    customerappEnabledResult = { data: true, error: null };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(lastRpcCall).not.toBeNull();
    expect(lastRpcCall!.fn).toBe("customerapp_enabled_for_org");
    expect(lastRpcCall!.args).toEqual({
      _org_id: "org-uuid-payload-cannot-influence-this",
    });
  });

  it("RPC error → fail closed → 403 customerapp_not_enabled (do NOT open the gate on its own failure)", async () => {
    stubValidLookup("org-uuid-1");
    customerappEnabledResult = {
      data: null,
      error: { message: "PostgREST: unable to reach DB" },
    };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 403, reason: "customerapp_not_enabled" });
  });

  it("RPC returns NULL (org row missing) → fail closed → 403", async () => {
    // Shouldn't happen given the FK on org_api_tokens.org_id, but pin
    // the defensive behavior anyway: only the literal boolean TRUE opens
    // the gate. NULL / undefined / anything-else closes it.
    stubValidLookup("org-uuid-1");
    customerappEnabledResult = { data: null, error: null };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 403, reason: "customerapp_not_enabled" });
  });

  it("flag flipped TRUE → FALSE mid-flight: next request 403s (no caching across calls)", async () => {
    stubValidLookup("org-uuid-flip");

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;

    // Call 1: flag TRUE → ok.
    customerappEnabledResult = { data: true, error: null };
    const res1 = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));
    expect(res1.ok).toBe(true);

    // Operator flips it FALSE (super_admin via SQL or future MBE UI).
    customerappEnabledResult = { data: false, error: null };

    // Call 2: same token, same org, but now the gate is closed.
    const res2 = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));
    expect(res2.ok).toBe(false);
    expect(res2).toMatchObject({ status: 403, reason: "customerapp_not_enabled" });
  });

  it("invalid token: 401 not_found wins over 403 (gate doesn't fire if auth fails)", async () => {
    // Lookup returns null (e.g. wrong env-prefix token sent to prod).
    // Gate must NOT be queried — exposing customerapp_enabled state to
    // unauthenticated callers would be a small but real info leak.
    lookupResult = { data: null, error: null };
    customerappEnabledResult = { data: false, error: null };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "not_found" });
    // Gate was not called.
    expect(lastRpcCall).toBeNull();
  });

  it("argon2-verify failure: 401 not_found wins over 403 (gate doesn't fire on wrong-secret)", async () => {
    // Lookup row exists, but the secret in the header doesn't match
    // the stored hash. Same reasoning as the prior test: don't reveal
    // opt-in state to a caller who can't even prove the credential.
    stubValidLookup("org-uuid-1");
    customerappEnabledResult = { data: false, error: null };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const wrongSecret = "WRONGwrongWRONGwrongWRONGwrongWRONGwrong123";
    const token = `mbe_dev_12345678_${wrongSecret}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "not_found" });
    expect(lastRpcCall).toBeNull();
  });

  it("revoked token: 401 revoked wins over 403 (gate doesn't fire on revoked token)", async () => {
    // Post-verify race-window check (#255 design): row was already
    // revoked_at-set at SELECT time (or in the race window after).
    // The gate must not fire — revoked is upstream of acceptance.
    lookupResult = {
      data: {
        id: "token-uuid-1",
        org_id: "org-uuid-1",
        name: "test-token",
        token_hash: KNOWN_HASH,
        revoked_at: "2026-05-26T12:00:00Z",
      },
      error: null,
    };
    customerappEnabledResult = { data: false, error: null };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "revoked" });
    expect(lastRpcCall).toBeNull();
  });

  it("denied-by-gate: last_used_at is NOT updated (we don't leak that a token+secret pair is valid)", async () => {
    // Defensive: if the gate rejects, don't help an attacker confirm
    // they've got a working credential by leaving a timestamp trail.
    stubValidLookup("org-uuid-1");
    customerappEnabledResult = { data: false, error: null };

    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    // Flush microtasks just in case some stray fire-and-forget update
    // tried to schedule.
    await new Promise((r) => setImmediate(r));

    expect(updatesByTable["org_api_tokens"]).toBeUndefined();
  });
});
