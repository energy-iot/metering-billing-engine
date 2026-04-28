// @vitest-environment jsdom
/**
 * install-session-from-url tests (UX5c/UX5d implicit-flow fix).
 *
 * Covers the dual-flow detection helper:
 *   - Implicit flow (URL fragment) — invite + recovery, success + errors.
 *   - OTP token-hash flow (query string) — invite + recovery, success + errors.
 *   - Detection priority: fragment with valid token wins over query.
 *   - Empty / malformed / missing-token edge cases.
 *   - Type mismatch (wrong type literal vs expectedType).
 *   - getUser failure modes after each primitive.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { installSessionFromUrl } from "../install-session-from-url";

type Loc = { hash: string; search: string };

function mkLoc(over: Partial<Loc> = {}): Loc {
  return { hash: "", search: "", ...over };
}

const FRAGMENT_INVITE = (over: Record<string, string> = {}) =>
  "#" +
  new URLSearchParams({
    access_token: "AT_VALID",
    refresh_token: "RT_VALID",
    expires_in: "3600",
    expires_at: "9999999999",
    token_type: "bearer",
    type: "invite",
    ...over,
  }).toString();

const FRAGMENT_RECOVERY = (over: Record<string, string> = {}) =>
  "#" +
  new URLSearchParams({
    access_token: "AT_VALID",
    refresh_token: "RT_VALID",
    expires_in: "3600",
    expires_at: "9999999999",
    token_type: "bearer",
    type: "recovery",
    ...over,
  }).toString();

const QUERY_INVITE = (over: Record<string, string> = {}) =>
  "?" +
  new URLSearchParams({
    token_hash: "TH_VALID",
    type: "invite",
    ...over,
  }).toString();

const QUERY_RECOVERY = (over: Record<string, string> = {}) =>
  "?" +
  new URLSearchParams({
    token_hash: "TH_VALID",
    type: "recovery",
    ...over,
  }).toString();

type AnyFn = (...args: unknown[]) => unknown;

let setSessionSpy: ReturnType<typeof vi.fn<AnyFn>>;
let verifyOtpSpy: ReturnType<typeof vi.fn<AnyFn>>;
let getUserSpy: ReturnType<typeof vi.fn<AnyFn>>;

function makeSupabase() {
  return {
    auth: {
      setSession: (...a: unknown[]) => setSessionSpy(...a),
      verifyOtp: (...a: unknown[]) => verifyOtpSpy(...a),
      getUser: (...a: unknown[]) => getUserSpy(...a),
    },
  } as unknown as Parameters<typeof installSessionFromUrl>[0]["supabase"];
}

beforeEach(() => {
  setSessionSpy = vi.fn<AnyFn>();
  verifyOtpSpy = vi.fn<AnyFn>();
  getUserSpy = vi.fn<AnyFn>();
});

describe("installSessionFromUrl — implicit flow (URL fragment)", () => {
  it("invite: setSession + getUser succeed → ok", async () => {
    setSessionSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "u1", email: "u@example.com" } },
      error: null,
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash: FRAGMENT_INVITE() }),
    });
    expect(result).toEqual({
      kind: "ok",
      user: { id: "u1", email: "u@example.com" },
    });
    expect(setSessionSpy).toHaveBeenCalledWith({
      access_token: "AT_VALID",
      refresh_token: "RT_VALID",
    });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("recovery: setSession + getUser succeed → ok", async () => {
    setSessionSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "u2", email: "r@example.com" } },
      error: null,
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "recovery",
      location: mkLoc({ hash: FRAGMENT_RECOVERY() }),
    });
    expect(result.kind).toBe("ok");
    expect(setSessionSpy).toHaveBeenCalledOnce();
  });

  it("type mismatch (recovery fragment, expecting invite) → type_mismatch", async () => {
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash: FRAGMENT_RECOVERY() }),
    });
    expect(result).toEqual({ kind: "type_mismatch" });
    expect(setSessionSpy).not.toHaveBeenCalled();
  });

  it("type mismatch (invite fragment, expecting recovery) → type_mismatch", async () => {
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "recovery",
      location: mkLoc({ hash: FRAGMENT_INVITE() }),
    });
    expect(result).toEqual({ kind: "type_mismatch" });
    expect(setSessionSpy).not.toHaveBeenCalled();
  });

  it("setSession returns error → verify_error", async () => {
    setSessionSpy.mockResolvedValue({
      data: {},
      error: { message: "invalid token", code: "bad_jwt" },
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash: FRAGMENT_INVITE() }),
    });
    expect(result).toEqual({
      kind: "verify_error",
      code: "bad_jwt",
      message: "invalid token",
    });
    expect(getUserSpy).not.toHaveBeenCalled();
  });

  it("setSession ok but getUser returns no user → verify_error", async () => {
    setSessionSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({ data: { user: null }, error: null });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash: FRAGMENT_INVITE() }),
    });
    expect(result.kind).toBe("verify_error");
  });

  it("fragment present but missing access_token → falls through to query (missing if no query)", async () => {
    const hash =
      "#" + new URLSearchParams({ refresh_token: "RT", type: "invite" }).toString();
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash }),
    });
    expect(result).toEqual({ kind: "missing" });
    expect(setSessionSpy).not.toHaveBeenCalled();
  });

  it("fragment present but missing refresh_token → falls through to query (missing if no query)", async () => {
    const hash =
      "#" + new URLSearchParams({ access_token: "AT", type: "invite" }).toString();
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash }),
    });
    expect(result).toEqual({ kind: "missing" });
    expect(setSessionSpy).not.toHaveBeenCalled();
  });

  it("fragment without auth tokens but with query token → falls through to OTP path", async () => {
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "u1", email: "u@example.com" } },
      error: null,
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({
        hash: "#some_diagnostic=foo",
        search: QUERY_INVITE(),
      }),
    });
    expect(result.kind).toBe("ok");
    expect(verifyOtpSpy).toHaveBeenCalledWith({
      token_hash: "TH_VALID",
      type: "invite",
    });
  });
});

describe("installSessionFromUrl — OTP flow (query string)", () => {
  it("invite: verifyOtp + getUser succeed → ok", async () => {
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ search: QUERY_INVITE() }),
    });
    expect(result.kind).toBe("ok");
    expect(verifyOtpSpy).toHaveBeenCalledWith({
      token_hash: "TH_VALID",
      type: "invite",
    });
  });

  it("recovery: verifyOtp + getUser succeed → ok", async () => {
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "u2" } },
      error: null,
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "recovery",
      location: mkLoc({ search: QUERY_RECOVERY() }),
    });
    expect(result.kind).toBe("ok");
  });

  it("type mismatch (invite query, expecting recovery) → type_mismatch", async () => {
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "recovery",
      location: mkLoc({ search: QUERY_INVITE() }),
    });
    expect(result).toEqual({ kind: "type_mismatch" });
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("verifyOtp returns generic error → verify_error", async () => {
    // Uses a non-spent-token code so we exercise the verify_error path.
    // Spent-token mapping is covered separately (#194).
    verifyOtpSpy.mockResolvedValue({
      data: {},
      error: { message: "rate limit hit", code: "rate_limited" },
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ search: QUERY_INVITE() }),
    });
    expect(result).toEqual({
      kind: "verify_error",
      code: "rate_limited",
      message: "rate limit hit",
    });
  });

  it("?error_description present → verify_error", async () => {
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({
        search: "?error_description=Invite%20expired&error_code=410",
      }),
    });
    expect(result.kind).toBe("verify_error");
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("verifyOtp ok but getUser returns no user → verify_error", async () => {
    verifyOtpSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({ data: { user: null }, error: null });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ search: QUERY_INVITE() }),
    });
    expect(result.kind).toBe("verify_error");
  });

  it("missing token_hash → missing", async () => {
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ search: "?type=invite" }),
    });
    expect(result).toEqual({ kind: "missing" });
  });
});

describe("installSessionFromUrl — empty / edge cases", () => {
  it("empty hash + empty search → missing", async () => {
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc(),
    });
    expect(result).toEqual({ kind: "missing" });
    expect(setSessionSpy).not.toHaveBeenCalled();
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("hash is just '#' → missing", async () => {
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash: "#" }),
    });
    expect(result).toEqual({ kind: "missing" });
  });

  it("malformed hash (random text) → missing (URLSearchParams parses but no tokens)", async () => {
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash: "#not-a-real-fragment" }),
    });
    expect(result).toEqual({ kind: "missing" });
  });

  it("both fragment + query — fragment wins", async () => {
    setSessionSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({
        hash: FRAGMENT_INVITE(),
        search: QUERY_INVITE({ token_hash: "TH_OTHER" }),
      }),
    });
    expect(result.kind).toBe("ok");
    expect(setSessionSpy).toHaveBeenCalledOnce();
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("undefined window (SSR safety) → missing", async () => {
    // Pass a stub `location` to simulate SSR-safe path: when no location
    // is provided AND window is undefined, returns missing. We exercise
    // the explicit-undefined branch by providing a location-less call —
    // jsdom defines window so the helper falls back to window.location
    // which has empty hash/search.
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
    });
    expect(result.kind).toBe("missing");
  });
});

describe("installSessionFromUrl — spent-token detection (#194)", () => {
  it("fragment with error_code=otp_expired → spent_token", async () => {
    const hash =
      "#" +
      new URLSearchParams({
        error: "access_denied",
        error_code: "otp_expired",
        error_description: "Email link is invalid or has expired",
      }).toString();
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash }),
    });
    expect(result).toEqual({ kind: "spent_token" });
    expect(setSessionSpy).not.toHaveBeenCalled();
    expect(verifyOtpSpy).not.toHaveBeenCalled();
  });

  it("fragment with error_code=email_link_invalid → spent_token", async () => {
    const hash =
      "#" +
      new URLSearchParams({
        error: "access_denied",
        error_code: "email_link_invalid",
        error_description: "Email link is invalid or has expired",
      }).toString();
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash }),
    });
    expect(result).toEqual({ kind: "spent_token" });
  });

  it("fragment with error_code=OTP_EXPIRED (uppercase) → spent_token (case-insensitive)", async () => {
    const hash =
      "#" +
      new URLSearchParams({
        error: "access_denied",
        error_code: "OTP_EXPIRED",
      }).toString();
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash }),
    });
    expect(result).toEqual({ kind: "spent_token" });
  });

  it("fragment with unknown error_code=foo_bar → missing (not spent_token)", async () => {
    // Fragment-only errors that DON'T match spent-token patterns fall
    // through to the query path. With no query token, result is missing.
    // (We do NOT surface a fragment-only generic error_code as
    // verify_error — current behavior preserved.)
    const hash =
      "#" +
      new URLSearchParams({
        error: "access_denied",
        error_code: "foo_bar",
      }).toString();
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash }),
    });
    expect(result).toEqual({ kind: "missing" });
  });

  it("setSession returns error with code:'otp_expired' → spent_token (verify_error→spent_token mapping)", async () => {
    setSessionSpy.mockResolvedValue({
      data: {},
      error: { message: "expired", code: "otp_expired" },
    });
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash: FRAGMENT_INVITE() }),
    });
    expect(result).toEqual({ kind: "spent_token" });
    expect(getUserSpy).not.toHaveBeenCalled();
  });

  it("fragment with BOTH access_token AND error → access_token path wins (NOT spent_token)", async () => {
    // Defensive coverage for AC1 precedence: if a malformed URL has
    // both auth tokens AND error params in the fragment, the implicit
    // happy path takes precedence (matches SDK behavior).
    setSessionSpy.mockResolvedValue({ data: {}, error: null });
    getUserSpy.mockResolvedValue({
      data: { user: { id: "u1", email: "u@example.com" } },
      error: null,
    });
    const hash =
      "#" +
      new URLSearchParams({
        access_token: "AT_VALID",
        refresh_token: "RT_VALID",
        type: "invite",
        error: "access_denied",
        error_code: "otp_expired",
      }).toString();
    const result = await installSessionFromUrl({
      supabase: makeSupabase(),
      expectedType: "invite",
      location: mkLoc({ hash }),
    });
    expect(result.kind).toBe("ok");
    expect(setSessionSpy).toHaveBeenCalledWith({
      access_token: "AT_VALID",
      refresh_token: "RT_VALID",
    });
  });
});
