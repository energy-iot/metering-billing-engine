import "server-only";
import argon2 from "argon2";
import { randomBytes } from "node:crypto";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Per-org API token auth (#255) — Authentication layer of the 4-layer
 * trust composition for the customerapp integration (#249).
 *
 * Replaces the dead-code `INTERNAL_API_KEY` shared-env-var model from
 * PR #246. The env var was never set in production; the routes have been
 * dead code since #246 landed. As of #255 the routes use this per-org
 * token system; the env var is removed entirely (no fallback / no
 * deprecation window).
 *
 * ── Token shape ──────────────────────────────────────────────────────────
 *
 * Plain text:  mbe_<env>_<lookup>_<secret>
 *   * <env>    — 2–8 chars (e.g. 'prod', 'stag', 'dev_') — env marker for
 *                log identification + accidental-cross-env-paste detection.
 *   * <lookup> — 8 hex chars (32 bits); NON-SECRET; indexed.
 *   * <secret> — 43 chars base64url (32 bytes of entropy); argon2id-hashed.
 *
 * Total length: 61 chars. argon2id is non-deterministic (random salt per
 * hash), so we cannot look up by hash. Industry-standard split-token
 * pattern (Stripe / GitHub / similar): non-secret lookup column indexes
 * the row; argon2-verify the secret remainder against the stored hash.
 *
 * ── Auth flow ────────────────────────────────────────────────────────────
 *
 *   1. Read `x-api-key` header → if missing, 401 missing_header.
 *   2. Regex-parse with TOKEN_RE → if no match, 401 invalid_format.
 *   3. Lookup row by token_lookup (service-role client, since this is the
 *      auth path itself) WHERE revoked_at IS NULL. If none, 401 not_found.
 *      Env prefix mismatch (staging token sent to prod) also hits not_found
 *      since prod's table doesn't carry that row — no need to separately
 *      reject by prefix.
 *   4. argon2.verify(row.token_hash, secret) → if fails, 401 not_found
 *      (same response for attack-surface reasons; don't leak presence).
 *   5. If row.revoked_at IS NOT NULL (race between lookup + verify), 401
 *      revoked. In practice the WHERE revoked_at IS NULL in step 3 catches
 *      this, but the check inside the verify branch covers the racy
 *      hard-cutover-regenerate window.
 *   6. (#251) Acceptance gate — call customerapp_enabled_for_org(row.org_id);
 *      if not TRUE, return 403 customerapp_not_enabled. A valid token alone
 *      is not enough — the org has to have opted in. Single enforcement site
 *      so a new route can't accidentally bypass.
 *   7. Update last_used_at = now() — fire-and-forget; do not await. Tiny
 *      per-request cost; UPDATE failure is benign (we lose a tick).
 *   8. Return { ok: true, org_id, token_id, token_name }.
 */

const TOKEN_RE =
  /^mbe_([a-z0-9_]{2,8})_([0-9a-f]{8})_([A-Za-z0-9_-]{43})$/;

// Default to 'dev_' for local dev; prod / staging deploys must set
// MBE_TOKEN_ENV_PREFIX explicitly so the generated tokens carry the right
// env marker.
const ENV_PREFIX = process.env.MBE_TOKEN_ENV_PREFIX ?? "dev_";

// OWASP 2024 guidance for argon2id. 19 MiB / 2 iterations / 1 thread on
// Vercel infra ≈ 10–20 ms per verify. Acceptable latency for internal-API
// calls; resistant to GPU/ASIC brute-force in the event of a DB leak.
const ARGON2_OPTS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

// ── Public types ─────────────────────────────────────────────────────────

export type TokenAuthOk = {
  ok: true;
  org_id: string;
  token_id: string;
  token_name: string;
};

export type TokenAuthFailReason =
  | "missing_header"
  | "invalid_format"
  | "not_found"
  | "revoked"
  | "customerapp_not_enabled";

export type TokenAuthFail = {
  ok: false;
  status: 401 | 403;
  reason: TokenAuthFailReason;
};

export type TokenAuthResult = TokenAuthOk | TokenAuthFail;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Verify the `x-api-key` header on an incoming request against the
 * `org_api_tokens` table. Returns the resolved org_id + token_name on
 * success; a structured failure with HTTP status on failure.
 *
 * Callers must respond with `NextResponse.json({error}, {status})` on
 * failure — do not leak the internal reason code shape to the caller
 * verbatim if you want to hide the auth-state distinction; the strings
 * are intentionally neutral (`not_found` covers both "wrong lookup" and
 * "wrong secret" by design).
 */
export async function resolveOrgFromToken(
  request: NextRequest
): Promise<TokenAuthResult> {
  const headerValue = request.headers.get("x-api-key");

  // SECURITY: never log header values. Only structured metadata (path, ip,
  // ua, reason, presence-boolean). The token plaintext never enters this
  // scope past the parsing step — header value is split into the
  // non-secret `lookup` and the `secret` that's passed straight into
  // argon2.verify; only those tokens exist after the parse step. This
  // helper closes over `keyPresent` (boolean) and the request metadata —
  // it does NOT close over the header value, the parsed secret, or the
  // lookup key. See #252.
  const reject = (
    reason: TokenAuthFailReason,
    status: 401 | 403 = 401
  ): TokenAuthFail => {
    console.warn(
      JSON.stringify({
        event: "internal_api_401",
        path: request.nextUrl.pathname,
        ip: request.headers.get("x-forwarded-for") ?? "unknown",
        ua: request.headers.get("user-agent") ?? "unknown",
        keyPresent: !!headerValue,
        reason,
        timestamp: new Date().toISOString(),
      })
    );
    return { ok: false, status, reason };
  };

  if (!headerValue) {
    return reject("missing_header");
  }

  const match = TOKEN_RE.exec(headerValue);
  if (!match) {
    return reject("invalid_format");
  }

  // match[1] is env_prefix (captured for completeness, not used at lookup
  // time — env mismatch surfaces as not_found per the design above).
  const lookup = match[2];
  const secret = match[3];

  const supabase = createServiceClient();

  const { data: row, error } = await supabase
    .from("org_api_tokens")
    .select("id, org_id, name, token_hash, revoked_at")
    .eq("token_lookup", lookup)
    .is("revoked_at", null)
    .maybeSingle();

  if (error || !row) {
    return reject("not_found");
  }

  let verifyOk = false;
  try {
    verifyOk = await argon2.verify(row.token_hash, secret);
  } catch {
    // Malformed stored hash, or argon2 internal error. Treat as not_found
    // to avoid leaking diagnostic info to unauthenticated callers.
    verifyOk = false;
  }

  if (!verifyOk) {
    return reject("not_found");
  }

  // Race-window check (#255 design): a regenerate could have flipped
  // revoked_at between our lookup and our argon2.verify. The WHERE in
  // step 3 should have caught it, but re-check after the verify completes
  // since verify can take ~15 ms.
  if (row.revoked_at !== null) {
    return reject("revoked");
  }

  // #251 — Acceptance gate. A valid token proves the credential layer;
  // the org also has to be opted into the customerapp integration before
  // any `/api/v1/*` call lands. Enforcement lives here (single site) so
  // a new route can't accidentally skip it.
  //
  // `customerapp_enabled_for_org(_org_id)` returns:
  //   * TRUE  → org has opted in; proceed.
  //   * FALSE → org has not opted in; 403 customerapp_not_enabled.
  //   * NULL  → org row missing (shouldn't happen given the FK on
  //             org_api_tokens.org_id, but treat as not-enabled).
  // The RPC `error` branch is treated as not-enabled too — we'd rather
  // fail closed than open if the gate query itself errors.
  //
  // #252: routed through `reject(...)` so the structured 401 log fires
  // for this 403 too; the log `event` stays `"internal_api_401"` for a
  // single log-search predicate across all rejections, and the `status`
  // field on the emitted reject result disambiguates 401 from 403.
  const { data: enabled, error: enabledErr } = await supabase.rpc(
    "customerapp_enabled_for_org",
    { _org_id: row.org_id }
  );
  if (enabledErr || enabled !== true) {
    return reject("customerapp_not_enabled", 403);
  }

  // Fire-and-forget last_used_at update. Failure is benign (we lose a
  // tick); never block the request critical path on this.
  void supabase
    .from("org_api_tokens")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", row.id)
    .then(({ error: updateErr }) => {
      if (updateErr) {
        console.warn(
          JSON.stringify({
            event: "internal_auth.last_used_at_update_failed",
            token_id: row.id,
            pg_code: (updateErr as { code?: string }).code ?? null,
            pg_message: updateErr.message,
            at: new Date().toISOString(),
          })
        );
      }
    });

  return {
    ok: true,
    org_id: row.org_id,
    token_id: row.id,
    token_name: row.name,
  };
}

// ── Token generation ─────────────────────────────────────────────────────

export type GeneratedToken = {
  /** Returned ONCE to the operator at creation time; never stored. */
  plaintext: string;
  /** 8 hex chars — written into org_api_tokens.token_lookup. */
  lookup: string;
  /** Env prefix used (e.g. 'prod', 'dev_') — written into env_prefix. */
  envPrefix: string;
  /** argon2id encoded hash — written into org_api_tokens.token_hash.
   *  Async because argon2.hash is async (it's CPU-bound and runs in a
   *  worker). Callers should `await hashPromise` before INSERTing the row. */
  hashPromise: Promise<string>;
};

/**
 * Generate a new API token. Returns the plaintext (return to operator
 * ONCE; never store), the lookup prefix (write to DB), and a promise that
 * resolves to the argon2id hash (write to DB).
 *
 * Usage (in #256 UI):
 *
 *   const t = generateToken();
 *   const hash = await t.hashPromise;
 *   await supabase.from("org_api_tokens").insert({
 *     org_id, name, token_lookup: t.lookup, token_hash: hash,
 *     env_prefix: t.envPrefix, created_by: userId,
 *   });
 *   // Return t.plaintext to the operator in the success response.
 */
export function generateToken(envPrefix: string = ENV_PREFIX): GeneratedToken {
  const lookup = randomBytes(4).toString("hex"); // 8 hex chars
  const secret = randomBytes(32).toString("base64url"); // 43 chars
  const plaintext = `mbe_${envPrefix}_${lookup}_${secret}`;
  return {
    plaintext,
    lookup,
    envPrefix,
    hashPromise: argon2.hash(secret, ARGON2_OPTS),
  };
}

// ── Microgrid → org resolution (#254 / #257) ─────────────────────────────

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MicrogridOrgOk = { ok: true; org_id: string };
export type MicrogridOrgFail = {
  ok: false;
  status: 404 | 400;
  reason: "microgrid_id_malformed" | "microgrid_not_found";
};

/**
 * Resolve a microgrid_id → org_id via the canonical
 * `microgrids → communities → org_id` chain.
 *
 * Consumed by #254 (authorization layer — does the token's org own this
 * microgrid?) and #257 (GET endpoints scoping reads to token's org).
 *
 * Status-code distinction is load-bearing: malformed UUID → 400,
 * non-existent → 404. Order matters at callsites: resolve to 404 BEFORE
 * comparing to the token's org_id, so a non-existent UUID never reveals
 * "exists in some other org" (UUID-enumeration defense, mirrors the
 * 2026-04 permission-before-target-lookup learning).
 */
export async function resolveMicrogridOrgId(
  supabase: SupabaseClient,
  microgrid_id: string
): Promise<MicrogridOrgOk | MicrogridOrgFail> {
  if (typeof microgrid_id !== "string" || !UUID_RE.test(microgrid_id)) {
    return { ok: false, status: 400, reason: "microgrid_id_malformed" };
  }

  const { data, error } = await supabase
    .from("microgrids")
    .select("id, communities!inner(org_id)")
    .eq("id", microgrid_id)
    .single();

  if (error || !data) {
    return { ok: false, status: 404, reason: "microgrid_not_found" };
  }

  // PostgREST returns the inner-joined relation as an object on .single().
  // TypeScript surfaces it as an array OR object depending on inference;
  // narrow via cast.
  const communities = data.communities as { org_id: string } | { org_id: string }[];
  const org_id = Array.isArray(communities) ? communities[0]?.org_id : communities?.org_id;
  if (!org_id) {
    return { ok: false, status: 404, reason: "microgrid_not_found" };
  }

  return { ok: true, org_id };
}
