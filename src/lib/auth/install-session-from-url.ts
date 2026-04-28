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
 *     implicit flow.
 *  2. URL query carries `token_hash` + `type` → OTP flow.
 *  3. Neither → `missing` (caller renders the standard "invalid or
 *     expired" error state).
 *
 * The `expectedType` parameter ("invite" | "recovery") gates the type
 * literal seen in the URL — a `recovery` link arriving at /accept-invite
 * (or vice versa) returns `type_mismatch`.
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
 *  - `verify_error` — token present but the SDK rejected it (expired,
 *    already used, etc.). `message` is suitable for logs; UIs should
 *    map to user-facing copy.
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
      const { error: setError } = await supabase.auth.setSession({
        access_token: fragment.access_token,
        refresh_token: fragment.refresh_token,
      });
      if (setError) {
        return {
          kind: "verify_error",
          code: setError.code,
          message: setError.message,
        };
      }
      const { data: userData, error: userError } = await supabase.auth.getUser();
      if (userError || !userData?.user) {
        return {
          kind: "verify_error",
          code: userError?.code,
          message: userError?.message ?? "Session install produced no user",
        };
      }
      return { kind: "ok", user: userData.user };
    }
    // Fragment present but missing access_token/refresh_token — fall
    // through to query-string detection. Some downstream tooling appends
    // diagnostic fragments without auth tokens.
  }

  // ── 2. OTP token-hash flow (query string) ────────────────────────
  const query = parseQuery(location.search);
  const tokenHash = query.get("token_hash");
  const type = query.get("type");
  const errorDescription =
    query.get("error_description") || query.get("error");

  if (errorDescription) {
    return {
      kind: "verify_error",
      code: query.get("error_code") ?? undefined,
      message: errorDescription,
    };
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
    return {
      kind: "verify_error",
      code: verifyError.code,
      message: verifyError.message,
    };
  }
  const { data: userData, error: userError } = await supabase.auth.getUser();
  if (userError || !userData?.user) {
    return {
      kind: "verify_error",
      code: userError?.code,
      message: userError?.message ?? "verifyOtp produced no user",
    };
  }
  return { kind: "ok", user: userData.user };
}

// ── Internals ──────────────────────────────────────────────────────

interface FragmentParams {
  access_token?: string;
  refresh_token?: string;
  type?: string;
}

/**
 * Parse a URL fragment of the form `#k1=v1&k2=v2&…` into a typed object.
 *
 * Returns `null` for empty / single-`#` fragments; callers treat that
 * as "no fragment-flow tokens present".
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
  };
}

function parseQuery(search: string): URLSearchParams {
  if (!search) return new URLSearchParams();
  const raw = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(raw);
}
