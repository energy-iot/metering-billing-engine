/**
 * install-session-from-url.ts — dual-flow session installer for landing
 * pages reached via Supabase confirmation emails (UX5c / #189, UX5d / #190).
 *
 * Background
 * ----------
 * Supabase email templates expand `{{ .ConfirmationURL }}` to a URL whose
 * shape depends on the project's auth-flow configuration:
 *
 *  1. **Implicit flow** (default for invite/recovery on most projects):
 *     `${redirectTo}#access_token=…&refresh_token=…&expires_in=3600&token_type=bearer&type=invite|recovery`
 *     The full JWT pair is delivered in the URL fragment. The fragment
 *     never reaches the server (it stays in the browser), and the SDK
 *     installs the session via `auth.setSession({ access_token,
 *     refresh_token })`.
 *
 *  2. **OTP token-hash flow**:
 *     `${redirectTo}?token_hash=…&type=invite|recovery&redirect_to=…`
 *     The query string carries an opaque hash that the SDK exchanges via
 *     `auth.verifyOtp({ token_hash, type })`.
 *
 * The previous UX5c/UX5d implementation (#189/#190) handled only path 2
 * (OTP) and broke against the actual production email URLs (which emit
 * path 1 — implicit flow). This helper handles BOTH so the pages are
 * robust to future auth-config changes.
 *
 * Detection priority
 * ------------------
 *  1. URL fragment carries `access_token` + `refresh_token` + `type` →
 *     implicit flow (happy path; wins even when error params are also
 *     present in the fragment).
 *  2. URL fragment carries `error_code` matching `otp_expired` /
 *     `email_link_invalid` (case-insensitive substring) → spent_token.
 *     This is the canonical carrier per GoTrue's
 *     `parseParametersFromURL` (`@supabase/auth-js/src/lib/helpers.ts`).
 *  3. URL query carries `token_hash` + `type` → OTP flow.
 *  4. URL query carries `error_description` / `error_code` → spent_token
 *     (if the code matches) or verify_error.
 *  5. Neither → `missing` (caller renders the standard "invalid or
 *     expired" error state).
 *
 * The `expectedType` parameter ("invite" | "recovery") gates the type
 * literal seen in the URL — a `recovery` link arriving at /accept-invite
 * (or vice versa) returns `type_mismatch`.
 *
 * Spent-token vs verify_error (#194)
 * -----------------------------------
 * Spent tokens (user already accepted/reset) are detected centrally and
 * surfaced as `kind: "spent_token"`. The discriminant carries no payload
 * — by the time the helper returns it, callers render fixed copy + a
 * directed CTA (Sign in for invite, Request a new link for recovery).
 *
 * The detection is defensive: GoTrue's `error_code` is `otp_expired` per
 * the SDK's typed `ErrorCode` union, but server-side variants like
 * `email_link_invalid` have been observed in the wild and are not in the
 * SDK's type. We match on lowercased substring against both so future
 * variants (`otp_expired_or_invalid`, etc.) are caught.
 *
 * Strict-Mode safety
 * ------------------
 * This helper is SIDE-EFFECTING on success: `setSession`/`verifyOtp`
 * install cookies AND the implicit-flow path consumes the access_token
 * (it's single-use across browsers, but the token-hash variant is
 * single-use globally). Callers MUST guard against React Strict Mode
 * double-mount — see the `verifyStartedRef` pattern in the page
 * components.
 *
 * Security note
 * -------------
 * The fragment is parsed CLIENT-SIDE only. The browser never sends the
 * fragment to the server, so the JWT does not leave the browser before
 * being installed via setSession.
 */
import type { SupabaseClient, User } from "@supabase/supabase-js";

export type ExpectedAuthType = "invite" | "recovery";

export type InstallSessionResult =
  | { kind: "ok"; user: User }
  | { kind: "missing" }
  | { kind: "type_mismatch" }
  | { kind: "spent_token" }
  | { kind: "verify_error"; code?: string; message: string };

export interface InstallSessionFromUrlParams {
  supabase: SupabaseClient;
  expectedType: ExpectedAuthType;
  /**
   * Optional accessor for the current URL — defaults to
   * `window.location`. Tests inject a stub for fragment/query control.
   */
  location?: Pick<Location, "hash" | "search">;
}

/**
 * Inspect the URL for invite/recovery confirmation params, install a
 * session via the appropriate Supabase primitive, and confirm the user
 * is reachable via `getUser()`.
 *
 * Returns a discriminated result — callers switch on `kind`:
 *  - `ok` — session installed, `user` populated.
 *  - `missing` — neither a fragment nor a query token was present;
 *    surface the standard "invalid or expired" error state.
 *  - `type_mismatch` — token present but `type` did not match
 *    `expectedType` (e.g. recovery link arrived at /accept-invite).
 *  - `spent_token` — the link has already been consumed (user clicked
 *    the same email twice, or revisited after acceptance). Detected via
 *    `error_code` matching `otp_expired` / `email_link_invalid` in
 *    fragment or query, OR via setSession/verifyOtp returning the same
 *    codes. Callers render a directed CTA — no payload needed.
 *  - `verify_error` — token present but the SDK rejected it for some
 *    other reason. `message` is suitable for logs; UIs should map to
 *    user-facing copy.
 */
export async function installSessionFromUrl(
  params: InstallSessionFromUrlParams
): Promise<InstallSessionResult> {
  const { supabase, expectedType } = params;
  const location =
    params.location ??
    (typeof window !== "undefined" ? window.location : undefined);

  if (!location) {
    return { kind: "missing" };
  }

  // ── 1. Implicit flow (URL fragment) ───────────────────────────────
  const fragment = parseFragment(location.hash);
  if (fragment) {
    if (fragment.access_token && fragment.refresh_token) {
      // Type guard runs FIRST — an unexpected `type` in the fragment is
      // a mismatch even if access_token/refresh_token are present.
      if (fragment.type && fragment.type !== expectedType) {
        return { kind: "type_mismatch" };
      }
      // access_token wins over fragment-level `error` params per
      // detection priority (matches SDK's implicit-flow happy path).
      const { error: setError } = await supabase.auth.setSession({
        access_token: fragment.access_token,
        refresh_token: fragment.refresh_token,
      });
      if (setError) {
        return mapErrorToResult(setError);
      }
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData?.user) {
        return mapErrorToResult(
          userError ?? { message: "Session install produced no user" }
        );
      }
      return { kind: "ok", user: userData.user };
    }

    // Fragment present but missing access_token/refresh_token. Check
    // for a spent-token signal in the fragment (the canonical carrier
    // for these errors per GoTrue) BEFORE falling through to the query
    // path.
    if (isSpentTokenCode(fragment.error_code)) {
      return { kind: "spent_token" };
    }
    // Fall through — fragment may be diagnostic (#some_diagnostic=foo)
    // or carry an unrecognized error. The query path may still produce
    // a usable result.
  }

  // ── 2. OTP token-hash flow (query string) ────────────────────────
  const query = parseQuery(location.search);
  const tokenHash = query.get("token_hash");
  const type = query.get("type");
  const queryErrorCode = query.get("error_code") ?? undefined;
  const queryErrorDescription =
    query.get("error_description") || query.get("error");

  if (queryErrorDescription || queryErrorCode) {
    if (isSpentTokenCode(queryErrorCode)) {
      return { kind: "spent_token" };
    }
    if (queryErrorDescription) {
      return {
        kind: "verify_error",
        code: queryErrorCode,
        message: queryErrorDescription,
      };
    }
  }

  if (!tokenHash) {
    return { kind: "missing" };
  }
  if (type !== expectedType) {
    return { kind: "type_mismatch" };
  }

  const { error: verifyError } = await supabase.auth.verifyOtp({
    token_hash: tokenHash,
    type: expectedType,
  });
  if (verifyError) {
    return mapErrorToResult(verifyError);
  }
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return mapErrorToResult(
      userError ?? { message: "verifyOtp produced no user" }
    );
  }
  return { kind: "ok", user: userData.user };
}

// ── Internals ──────────────────────────────────────────────────────

interface FragmentParams {
  access_token?: string;
  refresh_token?: string;
  type?: string;
  error?: string;
  error_code?: string;
  error_description?: string;
}

/**
 * Parse a URL fragment of the form `#k1=v1&k2=v2&…` into a typed object.
 *
 * Returns `null` for empty / single-`#` fragments; callers treat that
 * as "no fragment-flow tokens present".
 *
 * Captures both auth-token params (access/refresh/type) AND error
 * params (error/error_code/error_description) — GoTrue places spent-
 * token errors in the fragment, not the query, per
 * `@supabase/auth-js/src/lib/helpers.ts:parseParametersFromURL`.
 */
function parseFragment(hash: string): FragmentParams | null {
  if (!hash || hash === "#") return null;
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return null;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(raw);
  } catch {
    return null;
  }
  return {
    access_token: params.get("access_token") ?? undefined,
    refresh_token: params.get("refresh_token") ?? undefined,
    type: params.get("type") ?? undefined,
    error: params.get("error") ?? undefined,
    error_code: params.get("error_code") ?? undefined,
    error_description: params.get("error_description") ?? undefined,
  };
}

function parseQuery(search: string): URLSearchParams {
  if (!search) return new URLSearchParams();
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(raw);
}

/**
 * Map an `error_code` value (from URL fragment, URL query, or SDK
 * error object) to the spent-token discriminant.
 *
 * Match is case-insensitive substring against `otp_expired` and
 * `email_link_invalid`:
 * - `otp_expired` is the canonical SDK code (typed in
 *   `@supabase/auth-js/src/lib/error-codes.ts`).
 * - `email_link_invalid` is a server-side GoTrue value not in the SDK
 *   union, but observed in the wild — we match defensively to keep the
 *   user experience consistent across GoTrue server versions.
 */
function isSpentTokenCode(code: string | null | undefined): boolean {
  if (!code) return false;
  const lc = code.toLowerCase();
  return lc.includes("otp_expired") || lc.includes("email_link_invalid");
}

/**
 * Map an SDK error (from `setSession`, `verifyOtp`, or `getUser`) to a
 * helper-level discriminant. Routes spent-token codes to the dedicated
 * variant; everything else surfaces as `verify_error` with the original
 * code/message preserved for logs.
 */
function mapErrorToResult(error: {
  code?: string;
  message?: string;
}): InstallSessionResult {
  if (isSpentTokenCode(error.code)) {
    return { kind: "spent_token" };
  }
  return {
    kind: "verify_error",
    code: error.code,
    message: error.message ?? "Authentication failed",
  };
}
