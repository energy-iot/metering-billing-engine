/**
 * org_api_tokens.test.ts (#255)
 *
 * Failure-mode AC matrix for `resolveOrgFromToken` from the ticket body:
 *
 *   - Valid unrevoked token: succeeds; `last_used_at` updates (fire-and-forget).
 *   - Token missing `mbe_` prefix → 401 (invalid_format).
 *   - Token with wrong env prefix (staging token in prod) → 401 (not_found,
 *     since lookup row doesn't exist in prod's table).
 *   - Token format valid but no matching hash → 401 (not_found).
 *   - Token format valid, hash matches, but `revoked_at IS NOT NULL` → 401
 *     (revoked). Tested via the post-verify race-window branch since the
 *     primary lookup WHEREs revoked_at IS NULL out.
 *   - Hard-cutover regenerate: old token immediately 401s on next request;
 *     new token works on first request.
 *   - argon2id: incorrect token doesn't match a real hash (crypto sanity).
 *   - `last_used_at` UPDATE failure doesn't block auth success.
 *   - `generateToken` produces tokens matching the documented format regex
 *     (env / lookup / secret split).
 *
 * Architecture notes:
 *   - Tests run REAL argon2 (no mock) — at OWASP 2024 params each verify
 *     is ~15ms, so the whole suite < 1s. Mocking argon2 would lose the
 *     crypto-sanity coverage.
 *   - Supabase service-role client is mocked at the module boundary; the
 *     mock uses the `insertsByTable` / `updatesByTable` capture pattern
 *     (PR #259 lesson — single-variable capture silently drops the
 *     non-last write).
 *   - `last_used_at` update is fire-and-forget (`void`) inside the
 *     handler; the test schedules a microtask flush to assert it ran.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { NextRequest } from "next/server";
import argon2 from "argon2";

// ── Mock controls ──────────────────────────────────────────────────────────
//
// The `org_api_tokens` table is touched twice per successful auth (SELECT
// for lookup, then a fire-and-forget UPDATE for last_used_at). Capture
// inserts AND updates per-table so we can assert independently.
//
// `lookupResult` is what `from('org_api_tokens').select(...).eq(...).is(...).maybeSingle()`
// returns. Tests set it before invoking the handler.

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
let updatesByTable: Record<
  string,
  Array<{ payload: Record<string, unknown>; eqArgs?: [string, unknown] }>
> = {};
let updateError: { message: string; code?: string } | null = null;
// #251 — Acceptance-gate RPC stub. Tests set this to control whether the
// per-org opt-in check (`customerapp_enabled_for_org`) returns TRUE / FALSE
// or an error. Default TRUE so the existing #255 tests still exercise the
// success path; #251-specific tests in customerapp_enabled.test.ts flip it
// to FALSE / error to cover the gate rejection branch.
let customerappEnabledResult: {
  data: boolean | null;
  error: { message: string } | null;
} = { data: true, error: null };

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      // SELECT chain — used by the lookup path.
      select: () => ({
        eq: () => ({
          is: () => ({
            maybeSingle: () => Promise.resolve(lookupResult),
          }),
        }),
      }),
      // UPDATE chain — used by the fire-and-forget last_used_at write.
      // Returns a thenable so `void supabase.from(...).update(...).eq(...).then(...)`
      // resolves properly.
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
    // #251 — RPC stub for customerapp_enabled_for_org. Defaults to TRUE
    // so the existing #255 tests still exercise the success path; the
    // dedicated customerapp_enabled.test.ts flips it to cover the gate.
    rpc: (_fn: string, _args: Record<string, unknown>) =>
      Promise.resolve(customerappEnabledResult),
  }),
}));

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/v1/billing-periods", {
    method: "POST",
    headers,
  });
}

// Real argon2 hash of a known secret — generated once, reused across tests
// to keep the suite fast. Generated at module-load time; argon2.hash is
// async, so we await it in a beforeAll-style helper.
let KNOWN_SECRET: string;
let KNOWN_HASH: string;

beforeEach(async () => {
  vi.clearAllMocks();
  lookupResult = { data: null, error: null };
  updatesByTable = {};
  updateError = null;
  // #251 — default to opted-in so the #255 success-path tests still pass.
  customerappEnabledResult = { data: true, error: null };
  if (!KNOWN_HASH) {
    // 43-char base64url string — matches the secret format from generateToken.
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
  // Restore env so a later test in the same process isn't poisoned.
  delete process.env.MBE_TOKEN_ENV_PREFIX;
});

describe("resolveOrgFromToken (#255)", () => {
  it("401 missing_header when x-api-key absent", async () => {
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const res = await resolveOrgFromToken(makeRequest({}));
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "missing_header" });
  });

  it("401 invalid_format when header lacks `mbe_` prefix", async () => {
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const res = await resolveOrgFromToken(
      makeRequest({ "x-api-key": "not-an-mbe-token" })
    );
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "invalid_format" });
  });

  it("401 invalid_format when token has wrong shape (missing secret part)", async () => {
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const res = await resolveOrgFromToken(
      makeRequest({ "x-api-key": "mbe_dev__deadbeef_" })
    );
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "invalid_format" });
  });

  it("401 not_found when format valid but no matching lookup row (wrong-env-prefix case lands here)", async () => {
    lookupResult = { data: null, error: null };
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    // Format-valid token; lookup returns null (would happen for a staging
    // token sent to prod — the row doesn't exist in prod's org_api_tokens).
    const token =
      "mbe_stag_12345678_abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "not_found" });
  });

  it("401 not_found when lookup matches but argon2 verify fails (wrong secret)", async () => {
    // Lookup row exists; hash is real. Header carries a different secret —
    // argon2.verify returns false → not_found (not invalid_format).
    lookupResult = {
      data: {
        id: "token-uuid-1",
        org_id: "org-uuid-1",
        name: "test-token",
        token_hash: KNOWN_HASH,
        revoked_at: null,
      },
      error: null,
    };
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    // Secret is 43 chars but doesn't match KNOWN_SECRET.
    const wrongSecret = "WRONGwrongWRONGwrongWRONGwrongWRONGwrong123";
    const token = `mbe_dev_12345678_${wrongSecret}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "not_found" });
  });

  it("succeeds with valid token + fires last_used_at update", async () => {
    lookupResult = {
      data: {
        id: "token-uuid-1",
        org_id: "org-uuid-1",
        name: "customerapp-prod-2026",
        token_hash: KNOWN_HASH,
        revoked_at: null,
      },
      error: null,
    };
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));
    expect(res.ok).toBe(true);
    expect(res).toMatchObject({
      ok: true,
      org_id: "org-uuid-1",
      token_id: "token-uuid-1",
      token_name: "customerapp-prod-2026",
    });

    // Flush microtasks so the fire-and-forget UPDATE has a chance to land.
    await new Promise((r) => setImmediate(r));

    expect(updatesByTable["org_api_tokens"]).toHaveLength(1);
    const update = updatesByTable["org_api_tokens"][0];
    expect(update.payload).toHaveProperty("last_used_at");
    expect(typeof update.payload.last_used_at).toBe("string");
    expect(update.eqArgs).toEqual(["id", "token-uuid-1"]);
  });

  it("401 revoked via post-verify race-window check (revoked_at set in row despite WHERE)", async () => {
    // Simulate a race: the lookup WHERE revoked_at IS NULL passed (the row
    // had revoked_at=null at SELECT time), but a regenerate flipped it
    // before the verify completed. Test by stubbing the row with
    // revoked_at already set — exercises the in-handler race check.
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
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ status: 401, reason: "revoked" });
  });

  it("auth still succeeds when last_used_at UPDATE fails (fire-and-forget benign-failure)", async () => {
    lookupResult = {
      data: {
        id: "token-uuid-1",
        org_id: "org-uuid-1",
        name: "test-token",
        token_hash: KNOWN_HASH,
        revoked_at: null,
      },
      error: null,
    };
    updateError = { message: "simulated DB hiccup", code: "23505" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token = `mbe_dev_12345678_${KNOWN_SECRET}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));
    expect(res.ok).toBe(true);

    // Flush microtasks so the warn fires.
    await new Promise((r) => setImmediate(r));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("generateToken (#255)", () => {
  it("produces a token matching the documented format regex", async () => {
    const { generateToken } = await import("@/lib/internal-auth");
    const t = generateToken("prod");
    expect(t.plaintext).toMatch(
      /^mbe_prod_[0-9a-f]{8}_[A-Za-z0-9_-]{43}$/
    );
    expect(t.lookup).toMatch(/^[0-9a-f]{8}$/);
    expect(t.envPrefix).toBe("prod");

    // The hash promise resolves to a valid argon2 encoded string.
    const hash = await t.hashPromise;
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it("uses default env prefix when none provided", async () => {
    delete process.env.MBE_TOKEN_ENV_PREFIX;
    // Re-import to pick up the env default. vi.resetModules is required
    // because the env-prefix constant is captured at module load.
    vi.resetModules();
    const { generateToken } = await import("@/lib/internal-auth");
    const t = generateToken();
    expect(t.plaintext).toMatch(/^mbe_dev__/);
    expect(t.envPrefix).toBe("dev_");
  });

  it("generates round-trippable hash + verify", async () => {
    // Crypto sanity check — hash a real token, verify it matches; verify
    // a different secret against the same hash and it doesn't match.
    const { generateToken } = await import("@/lib/internal-auth");
    const t = generateToken("dev");
    const hash = await t.hashPromise;
    // Parse plaintext via the canonical token regex to extract the secret
    // (using `.split('_')` is unsafe because env_prefix may contain `_`,
    // e.g. the default 'dev_').
    const match = /^mbe_([a-z0-9_]{2,8})_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/.exec(
      t.plaintext
    );
    expect(match).not.toBeNull();
    const secret = match![3];
    expect(await argon2.verify(hash, secret)).toBe(true);
    expect(await argon2.verify(hash, "wrong-secret-43-chars-_-aaaaaaaaaaaaa")).toBe(
      false
    );
  });

  it("produces unique lookup + secret per call", async () => {
    const { generateToken } = await import("@/lib/internal-auth");
    const a = generateToken("dev_");
    const b = generateToken("dev_");
    expect(a.lookup).not.toBe(b.lookup);
    expect(a.plaintext).not.toBe(b.plaintext);
  });
});

describe("hard-cutover regenerate behavior (#255)", () => {
  it("old token 401s once revoked_at is set; new token works on first request", async () => {
    // Simulates the #256 regenerate flow at the auth layer:
    //   1. Old token: WHERE revoked_at IS NULL on lookup → no row → not_found.
    //   2. New token: lookup returns the new row → argon2.verify → ok.
    const { resolveOrgFromToken, generateToken } = await import(
      "@/lib/internal-auth"
    );

    const oldToken = generateToken("dev_");
    const newToken = generateToken("dev_");

    // Old token: row excluded by WHERE revoked_at IS NULL (regenerate set it).
    lookupResult = { data: null, error: null };
    const resOld = await resolveOrgFromToken(
      makeRequest({ "x-api-key": oldToken.plaintext })
    );
    expect(resOld.ok).toBe(false);
    expect(resOld).toMatchObject({ status: 401, reason: "not_found" });

    // New token: row exists, hash matches → ok.
    const newHash = await newToken.hashPromise;
    lookupResult = {
      data: {
        id: "new-token-uuid",
        org_id: "org-uuid-1",
        name: "regenerated-2026-05-26",
        token_hash: newHash,
        revoked_at: null,
      },
      error: null,
    };
    const resNew = await resolveOrgFromToken(
      makeRequest({ "x-api-key": newToken.plaintext })
    );
    expect(resNew.ok).toBe(true);
    expect(resNew).toMatchObject({
      ok: true,
      org_id: "org-uuid-1",
      token_name: "regenerated-2026-05-26",
    });
  });
});
