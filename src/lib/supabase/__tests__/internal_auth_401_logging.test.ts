/**
 * internal_auth_401_logging.test.ts (#252)
 *
 * Observability AC matrix for `resolveOrgFromToken`:
 *
 *   - Every 401 path emits exactly one structured `internal_api_401` log
 *     entry with the documented shape (event / path / ip / ua / keyPresent /
 *     reason / timestamp).
 *   - The 200 path does NOT emit a per-request log entry (no log spam on
 *     success; only the fire-and-forget `last_used_at_update_failed` event
 *     emits on UPDATE failure — that path is covered in
 *     `org_api_tokens.test.ts`).
 *   - The token value itself NEVER appears in any logged string under any
 *     rejection path. The negative assertion is the load-bearing one — it
 *     catches a regression where a future contributor adds a "helpful"
 *     `console.log(header)` somewhere upstream.
 *
 * The `org_api_tokens.test.ts` suite owns the auth-result correctness
 * matrix; this suite owns the LOG-EMISSION correctness matrix. They share
 * the same Supabase service-client mock shape (insertsByTable /
 * updatesByTable capture, per PR #259's lesson).
 *
 * Architecture note: this test file does NOT cover the
 * `customerapp_not_enabled` reason — that branch is added by #251
 * (parallel-PR; not on main at #252 dispatch). Once #251 lands, extend
 * the parametrised list at the bottom of this file to include the 5th
 * reason.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import argon2 from "argon2";

// ── Supabase mock — shape mirrors org_api_tokens.test.ts ─────────────────

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

// #251 added a `supabase.rpc("customerapp_enabled_for_org", { _org_id })` gate
// inside `resolveOrgFromToken`'s success path. The default mock returns
// `{ data: true }` so the success-path tests in this suite still reach the
// `last_used_at` update + return-ok branch without tripping the acceptance
// gate. Individual tests that exercise the `customerapp_not_enabled` reject
// branch can flip `rpcResult` in their setup. The RPC call is fire-and-NOT-
// forget for this branch (await; failure → reject), so the resolved value
// matters.
let rpcResult: {
  data: boolean | null;
  error: { message: string; code?: string } | null;
} = { data: true, error: null };

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
    rpc: (_fn: string, _args: Record<string, unknown>) => Promise.resolve(rpcResult),
  }),
}));

// Fixed metadata so we can assert exact log values.
const REQUEST_PATH = "/api/v1/billing-periods";
const REQUEST_URL = `http://localhost${REQUEST_PATH}`;
const CALLER_IP = "203.0.113.42"; // RFC 5737 documentation-range IP
const CALLER_UA = "customerapp/0.1 (probe-test)";

function makeRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest(REQUEST_URL, {
    method: "POST",
    headers: {
      "x-forwarded-for": CALLER_IP,
      "user-agent": CALLER_UA,
      ...headers,
    },
  });
}

let KNOWN_SECRET: string;
let KNOWN_HASH: string;

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.clearAllMocks();
  lookupResult = { data: null, error: null };
  updatesByTable = {};
  updateError = null;
  rpcResult = { data: true, error: null };  // #251 default: customerapp_enabled = true
  if (!KNOWN_HASH) {
    KNOWN_SECRET = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
    KNOWN_HASH = await argon2.hash(KNOWN_SECRET, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

// Helpers for parsing the structured-log payloads emitted to console.warn.

type StructuredLog = {
  event: string;
  path: string;
  ip: string;
  ua: string;
  keyPresent: boolean;
  reason: string;
  timestamp: string;
};

function logEntries(): StructuredLog[] {
  return (warnSpy.mock.calls as unknown[][])
    .map((call) => call[0])
    .filter((arg): arg is string => typeof arg === "string")
    .map((s) => {
      try {
        return JSON.parse(s) as StructuredLog;
      } catch {
        return null;
      }
    })
    .filter((v): v is StructuredLog => v !== null);
}

function api401Entries(): StructuredLog[] {
  return logEntries().filter((e) => e.event === "internal_api_401");
}

function allLoggedText(): string {
  // Concatenate every arg from every call to console.warn into one string —
  // catches both the structured JSON path and any naive `console.warn(header)`
  // regression.
  return (warnSpy.mock.calls as unknown[][])
    .map((call) =>
      call.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join(" ")
    )
    .join(" ");
}

// ── Shared assertion: structured-log shape ───────────────────────────────

function assertStructuredShape(entry: StructuredLog, expectedReason: string, expectedKeyPresent: boolean) {
  expect(entry.event).toBe("internal_api_401");
  expect(entry.path).toBe(REQUEST_PATH);
  expect(entry.ip).toBe(CALLER_IP);
  expect(entry.ua).toBe(CALLER_UA);
  expect(entry.keyPresent).toBe(expectedKeyPresent);
  expect(entry.reason).toBe(expectedReason);
  // ISO 8601 timestamp; new Date(entry.timestamp) should round-trip.
  expect(typeof entry.timestamp).toBe("string");
  expect(Number.isNaN(new Date(entry.timestamp).getTime())).toBe(false);
}

// ─────────────────────────────────────────────────────────────────────────

describe("resolveOrgFromToken — structured 401 logging (#252)", () => {
  it("missing_header: emits structured log with keyPresent=false", async () => {
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const res = await resolveOrgFromToken(makeRequest({}));

    expect(res.ok).toBe(false);
    const entries = api401Entries();
    expect(entries).toHaveLength(1);
    assertStructuredShape(entries[0], "missing_header", false);
  });

  it("invalid_format: emits structured log with keyPresent=true", async () => {
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const res = await resolveOrgFromToken(
      makeRequest({ "x-api-key": "not-an-mbe-token" })
    );

    expect(res.ok).toBe(false);
    const entries = api401Entries();
    expect(entries).toHaveLength(1);
    assertStructuredShape(entries[0], "invalid_format", true);
  });

  it("not_found (no matching lookup row): emits structured log with keyPresent=true", async () => {
    lookupResult = { data: null, error: null };
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const token =
      "mbe_stag_12345678_abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(false);
    const entries = api401Entries();
    expect(entries).toHaveLength(1);
    assertStructuredShape(entries[0], "not_found", true);
  });

  it("not_found (argon2 verify miss): emits structured log with keyPresent=true", async () => {
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
    const wrongSecret = "WRONGwrongWRONGwrongWRONGwrongWRONGwrong123";
    const token = `mbe_dev_12345678_${wrongSecret}`;
    const res = await resolveOrgFromToken(makeRequest({ "x-api-key": token }));

    expect(res.ok).toBe(false);
    const entries = api401Entries();
    expect(entries).toHaveLength(1);
    assertStructuredShape(entries[0], "not_found", true);
  });

  it("revoked (race-window check): emits structured log with keyPresent=true", async () => {
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
    const entries = api401Entries();
    expect(entries).toHaveLength(1);
    assertStructuredShape(entries[0], "revoked", true);
  });

  it("missing x-forwarded-for + missing user-agent → ip='unknown' ua='unknown'", async () => {
    // Fall back to a request without the default headers to exercise the
    // `?? "unknown"` defaults in the log.
    const req = new NextRequest(REQUEST_URL, { method: "POST", headers: {} });
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    const res = await resolveOrgFromToken(req);

    expect(res.ok).toBe(false);
    const entries = api401Entries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      event: "internal_api_401",
      path: REQUEST_PATH,
      ip: "unknown",
      ua: "unknown",
      keyPresent: false,
      reason: "missing_header",
    });
  });

  it("200 success path emits NO internal_api_401 log entry (no log spam on success)", async () => {
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

    // Flush microtasks so any fire-and-forget UPDATE settles.
    await new Promise((r) => setImmediate(r));

    expect(res.ok).toBe(true);
    expect(api401Entries()).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────

describe("resolveOrgFromToken — token-never-logged invariant (#252)", () => {
  // The negative assertion is the load-bearing one. If a contributor adds a
  // `console.log(header)` or `console.warn("rejecting token", header)`
  // anywhere upstream of (or inside) resolveOrgFromToken, these assertions
  // will fire even if the structured-log shape stays correct.

  const FULL_TOKEN = `mbe_dev_12345678_${"abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE"}`;
  const LOOKUP_FRAGMENT = "12345678";
  const SECRET_FRAGMENT = "abcdefghijklmnopqrstuvwxyz0123456789_-ABCDE";

  it("invalid_format path: token value absent from any log line", async () => {
    const probeToken = "mbe_prod_ABCDEFGH_thisIsTheSecretValueDoNotLogMe___OK"; // malformed — hex regex rejects
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    await resolveOrgFromToken(makeRequest({ "x-api-key": probeToken }));

    const text = allLoggedText();
    expect(text).not.toContain(probeToken);
    // Belt-and-suspenders: the would-be lookup + secret fragments alone.
    expect(text).not.toContain("ABCDEFGH");
    expect(text).not.toContain("thisIsTheSecretValueDoNotLogMe");
  });

  it("not_found (lookup miss) path: token value absent from any log line", async () => {
    lookupResult = { data: null, error: null };
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    await resolveOrgFromToken(makeRequest({ "x-api-key": FULL_TOKEN }));

    const text = allLoggedText();
    expect(text).not.toContain(FULL_TOKEN);
    expect(text).not.toContain(SECRET_FRAGMENT);
    expect(text).not.toContain(LOOKUP_FRAGMENT);
  });

  it("not_found (argon2 miss) path: token value absent from any log line", async () => {
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
    const wrongSecret = "WRONGwrongWRONGwrongWRONGwrongWRONGwrong123";
    const wrongToken = `mbe_dev_12345678_${wrongSecret}`;
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    await resolveOrgFromToken(makeRequest({ "x-api-key": wrongToken }));

    const text = allLoggedText();
    expect(text).not.toContain(wrongToken);
    expect(text).not.toContain(wrongSecret);
    expect(text).not.toContain("12345678");
  });

  it("revoked path: token value absent from any log line", async () => {
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
    await resolveOrgFromToken(makeRequest({ "x-api-key": FULL_TOKEN }));

    const text = allLoggedText();
    expect(text).not.toContain(FULL_TOKEN);
    expect(text).not.toContain(SECRET_FRAGMENT);
    expect(text).not.toContain(LOOKUP_FRAGMENT);
  });

  it("missing_header path: nothing token-like makes it into logs", async () => {
    const { resolveOrgFromToken } = await import("@/lib/internal-auth");
    await resolveOrgFromToken(makeRequest({}));

    const text = allLoggedText();
    // No header was sent — but assert no `mbe_` token-fragment leaked from
    // anywhere else (e.g. a stack trace or upstream log).
    expect(text).not.toMatch(/mbe_[a-z0-9_]{2,8}_[0-9a-f]{8}_/);
  });
});
