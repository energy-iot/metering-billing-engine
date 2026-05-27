import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { PaymentError } from "./errors";
import { getPaymentProviderClient } from "./factory";
import { getCommunityPaymentConfig } from "./config";
import { buildOrderParamsFromLineItem } from "./pesapal/build-params";
import { buildOrderId } from "./pesapal/order-id";

/**
 * ensure-payment-link.ts — shared "ensure a Pesapal redirect URL exists for
 * this line item" service.
 *
 * Used by:
 *   - POST /api/billing-line-items/[id]/url   (existing operator endpoint)
 *   - GET  /api/billing-line-items/[id]/pay   (new public redirect — #202)
 *   - GET  /api/billing-line-items/[id]/pdf   (PDF1b — proactive ensure on render)
 *
 * Contract per AC6 of #202 (R3 optimistic concurrency):
 *
 *   1. Plain SELECT for the cache check (no FOR UPDATE — supabase-js doesn't
 *      span transactions across calls). If `pesapal_redirect_url` is non-null
 *      → return cache hit.
 *   2. If null → call Pesapal `submitOrder` (HTTP).
 *   3. UPDATE billing_line_items SET pesapal_redirect_url = $1
 *        WHERE id = $2 AND pesapal_redirect_url IS NULL
 *        RETURNING *.
 *      The `WHERE ... IS NULL` guard is the serialisation point.
 *      - RETURNING one row → this caller won; fire the audit write.
 *      - RETURNING zero rows → another concurrent caller won; re-SELECT and
 *        return their URL. Do NOT fire the audit write (they already did).
 *
 * Wasted-mint trade-off: two concurrent callers may both mint a Pesapal
 * session before the UPDATE-NULL guard fires; one wins, the other's session
 * is silently dropped. Acceptable trade for "correct serialisation without a
 * multi-statement transaction."
 *
 * Per-instance defense-in-depth coalescing: an in-memory
 * `Map<lineItemId, Promise<...>>` collapses concurrent callers within the
 * same Node process so they share a single Pesapal call. Per-instance, not
 * cluster-wide — same scope caveat as the rate-limiter.
 *
 * Audit-write side effect: on the mint path, fires
 * `fn_apply_payment_event(_to_status: 'link_generated', _source: 'generate_link')`
 * to record the unpaid → link_generated transition. Same warn-loudly-but-
 * still-return semantic as the existing /url route. On the cache path AND
 * the UPDATE-NULL-loser path: NO audit write (no transition occurred).
 *
 * Defensive case: an already-paid line item with `pesapal_redirect_url IS NULL`
 * (degenerate hand-edit state) hits the mint path, attempts a paid →
 * link_generated transition which `fn_apply_payment_event` rejects with
 * `invalid_transition` (P0001). The wrap catches and warns; the helper still
 * returns the minted URL with `wasMinted: true`.
 *
 * Error contract: throws `PaymentError` (parent class) — including its
 * subclass hierarchy (`PesapalError`, etc.). Existing call sites'
 * `mapPaymentError(err)` (in /url's route handler) continues to work. The
 * helper does NOT introduce a new error type.
 *
 * Client variant: the helper accepts the caller's Supabase client and uses
 * it as-is. Callers from session-auth'd routes pass their session client so
 * RLS applies; the new /pay route passes a service-role client (RLS bypassed
 * by design — D6 + D16). `getCommunityPaymentConfig` chains to
 * `fn_get_community_payment_secret` which honors both paths via the
 * `auth.role() = 'service_role' OR user_can_access_org(...)` gate
 * (00030_payment_secret_org_manager.sql:73).
 */

// ── Public types ─────────────────────────────────────────────────────────────

export interface EnsurePaymentLinkResult {
  /** Always populated. */
  redirectUrl: string;
  /**
   * Pesapal `OrderTrackingId` — only populated on the mint path. Returns
   * `null` on cache hit because `OrderTrackingId` is not persisted as a
   * column on `billing_line_items` (it lives only inside
   * `payment_events.raw_payload`, see 00028:264-287).
   */
  orderTrackingId: string | null;
  /**
   * Merchant reference (the `pesapal_order_id` we generate via
   * `buildOrderId`). Returns `null` on cache hit; the persisted column IS on
   * `billing_line_items.pesapal_order_id` but we don't re-read it on cache
   * hits because the only consumer (the UI) ignores both fields.
   */
  merchantReference: string | null;
  /** True iff this call freshly minted; false on cache hit / loser path. */
  wasMinted: boolean;
}

export interface EnsurePaymentLinkOptions {
  /** Caller's auth.uid() if known (session routes); null for /pay. */
  actorUserId?: string | null;
  /**
   * Defaults to `'human'` for session-auth'd routes. The public `/pay`
   * (consumer-initiated redirect) and other no-session callers MUST set
   * `'system'` AND `actorRef` — the DB CHECK on `payment_events` rejects
   * `actor_kind='human'` rows with `actor_user_id IS NULL`. See migration
   * 00041 / #250.
   */
  actorKind?: "human" | "customerapp" | "system";
  /** Opaque caller-supplied identifier; required by DB CHECK whenever
   *  `actorKind != 'human'`. */
  actorRef?: string | null;
  /** Override the callback URL; defaults to NEXT_PUBLIC_PAYMENT_CALLBACK_URL. */
  callbackUrl?: string;
  /**
   * Operator-explicit "Regenerate" (#217). When true:
   *   - Skip the cache-check (any existing pesapal_redirect_url is overwritten).
   *   - Skip the in-memory coalescer in BOTH directions (the operator does
   *     not piggyback onto a tenant /pay's mint, and concurrent tenant /pay
   *     callers do not coalesce onto the operator's force result).
   *   - Mint a fresh Pesapal session.
   *   - UPDATE both `pesapal_redirect_url` AND `pesapal_order_id` in a single
   *     statement UNCONDITIONALLY (no WHERE pesapal_redirect_url IS NULL
   *     guard) so the row is internally consistent at every observable instant.
   *   - Fire the `link_generated` audit-write side effect with the existing
   *     warn-loudly-but-still-return semantic on rejection (paid →
   *     link_generated raises P0001; the helper warns and returns the URL).
   *
   * Default `false` — current behaviour preserved for tenant /pay callers
   * (they share the cache; the cache exists to dedupe their parallel
   * redirect clicks).
   */
  force?: boolean;
}

// ── In-memory coalescer ──────────────────────────────────────────────────────

/**
 * Coalesces concurrent calls for the SAME lineItemId within the SAME Node
 * process so they share a single Pesapal `submitOrder`. Per-instance, not
 * cluster-wide; the optimistic-concurrency UPDATE remains the authoritative
 * serialisation point across instances.
 */
const inflight = new Map<string, Promise<EnsurePaymentLinkResult>>();

// ── Internals ────────────────────────────────────────────────────────────────

const DEFAULT_CALLBACK_URL =
  process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL ??
  "http://localhost:3000/payment/callback";

type LineItemScopeRow = {
  id: string;
  pesapal_redirect_url: string | null;
  payment_status: string | null;
  billing_period_id: string;
  billing_periods:
    | {
        id: string;
        microgrid_id: string;
        microgrids:
          | {
              id: string;
              community_id: string;
              currency: string | null;
            }
          | null;
      }
    | null;
};

/** Internal: resolve the line-item scope (period → microgrid → community). */
async function loadLineItemScope(
  supabase: SupabaseClient,
  lineItemId: string,
): Promise<{
  pesapalRedirectUrl: string | null;
  paymentStatus: string | null;
  microgridId: string;
  communityId: string;
  currency: string | null;
}> {
  const { data, error } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
      pesapal_redirect_url,
      payment_status,
      billing_period_id,
      billing_periods!inner (
        id,
        microgrid_id,
        microgrids!inner (
          id,
          community_id,
          currency
        )
      )
    `,
    )
    .eq("id", lineItemId)
    .maybeSingle<LineItemScopeRow>();

  if (error) {
    throw new PaymentError(
      `Failed to look up billing line item: ${error.message}`,
      "PAYMENT_INVALID_CONFIG",
      500,
      error,
    );
  }
  if (!data) {
    // RLS hid it OR the row does not exist — same response from the helper's
    // perspective. The /pay route maps this to 404; /url maps it to 404 too.
    throw new PaymentError(
      `Billing line item ${lineItemId} not found`,
      "PESAPAL_LINE_ITEM_NOT_FOUND",
      404,
    );
  }

  // PostgREST may return joined singletons as single-element arrays; normalize.
  const period = Array.isArray(data.billing_periods)
    ? data.billing_periods[0]
    : data.billing_periods;
  const microgrid = period
    ? Array.isArray(period.microgrids)
      ? period.microgrids[0]
      : period.microgrids
    : null;

  if (!period || !microgrid) {
    throw new PaymentError(
      `Billing line item ${lineItemId} not found`,
      "PESAPAL_LINE_ITEM_NOT_FOUND",
      404,
    );
  }

  return {
    pesapalRedirectUrl: data.pesapal_redirect_url,
    paymentStatus: data.payment_status,
    microgridId: period.microgrid_id,
    communityId: microgrid.community_id,
    currency: microgrid.currency,
  };
}

async function mintAndPersist(
  supabase: SupabaseClient,
  lineItemId: string,
  scope: {
    communityId: string;
    currency: string | null;
  },
  opts: EnsurePaymentLinkOptions,
): Promise<EnsurePaymentLinkResult> {
  const force = opts.force === true;

  // 1. Resolve community payment config (config + decrypted secret).
  const paymentConfig = await getCommunityPaymentConfig(
    supabase,
    scope.communityId,
  );
  if (!paymentConfig) {
    throw new PaymentError(
      "No payment provider configured for this community.",
      "PAYMENT_NOT_CONFIGURED",
      409,
    );
  }

  // 2. Build the per-line-item order params (amount, description,
  //    billing-address). Throws PESAPAL_LINE_ITEM_NOT_FOUND or
  //    PESAPAL_HOUSEHOLD_NOT_FOUND on lookup failure; PESAPAL_MISSING_CONTACT
  //    or PESAPAL_ZERO_AMOUNT on validation failure.
  const built = await buildOrderParamsFromLineItem(supabase, lineItemId);

  // 3. Currency: prefer microgrid.currency; fall back to UGX with a warning
  //    (mirrors the /url route's behaviour at route.ts:222-233).
  let currency = scope.currency ?? "";
  if (!currency) {
    console.warn(
      JSON.stringify({
        event: "payment.ensure_link.currency_fallback",
        line_item_id: lineItemId,
        fallback: "UGX",
        at: new Date().toISOString(),
      }),
    );
    currency = "UGX";
  }

  // 4. Pesapal rejects reused `id` — fresh per call (architect R8).
  const orderId = buildOrderId(lineItemId);

  // 5. Dispatch through the factory.
  const client = getPaymentProviderClient(paymentConfig);
  const result = await client.generatePaymentLink({
    lineItemId,
    orderId,
    amount: built.amount,
    description: built.description,
    billingAddress: built.billingAddress,
    callbackUrl: opts.callbackUrl ?? DEFAULT_CALLBACK_URL,
    currency,
  });

  // 6. Persist. Two paths:
  //
  //    force=false (default):
  //      Optimistic-concurrency UPDATE-NULL guard. Only the first caller's
  //      UPDATE wins; the loser re-SELECTs the winner's URL.
  //
  //    force=true (operator-explicit "Regenerate" — #217):
  //      Drop the WHERE-IS-NULL guard. Operator intent is to overwrite any
  //      stale cache. Write both `pesapal_redirect_url` AND `pesapal_order_id`
  //      in the same UPDATE so the row is internally consistent at every
  //      observable instant (no momentary stale-pair window). Always treat
  //      this caller as the winner — fire the audit write directly.
  const updateBuilder = force
    ? supabase
        .from("billing_line_items")
        .update({
          pesapal_redirect_url: result.redirectUrl,
          pesapal_order_id: result.providerReference,
        })
        .eq("id", lineItemId)
        .select("id, pesapal_redirect_url")
    : supabase
        .from("billing_line_items")
        .update({ pesapal_redirect_url: result.redirectUrl })
        .eq("id", lineItemId)
        .is("pesapal_redirect_url", null)
        .select("id, pesapal_redirect_url");

  const { data: updated, error: updateErr } = await updateBuilder;

  if (updateErr) {
    throw new PaymentError(
      `Failed to persist payment redirect URL: ${updateErr.message}`,
      "PAYMENT_INVALID_CONFIG",
      500,
      updateErr,
    );
  }

  if (force || (updated && updated.length > 0)) {
    // Winner. Fire the audit write (warn-loudly-but-still-return on failure).
    try {
      // SIGNATURE NOTE: this RPC's signature was widened in #250
      // (actor_kind, actor_ref). PostgREST overload-resolution will reject
      // DROP-less signature changes with PGRST203. Any future param
      // addition requires `DROP FUNCTION IF EXISTS` in the migration
      // BEFORE `CREATE OR REPLACE`. See PR #209 / #250 for prior lessons.
      const actorKind = opts.actorKind ?? "human";
      const { error: rpcErr } = await supabase.rpc("fn_apply_payment_event", {
        _line_item_id: lineItemId,
        _to_status: "link_generated",
        _source: "generate_link",
        _actor_user_id: opts.actorUserId ?? null,
        _raw_payload: {
          pesapal_order_id: result.providerReference,
          provider_order_tracking_id: result.providerOrderId,
          // redirect_url intentionally NOT logged — contains a session token.
        },
        _actor_kind: actorKind,
        _actor_ref: opts.actorRef ?? null,
      });
      if (rpcErr) {
        console.warn(
          JSON.stringify({
            event: "payment.ensure_link.audit_write_failed",
            line_item_id: lineItemId,
            pg_code: rpcErr.code,
            pg_message: rpcErr.message,
            at: new Date().toISOString(),
          }),
        );
      }
    } catch (err) {
      console.warn(
        JSON.stringify({
          event: "payment.ensure_link.audit_write_threw",
          line_item_id: lineItemId,
          message: err instanceof Error ? err.message : String(err),
          at: new Date().toISOString(),
        }),
      );
    }

    return {
      redirectUrl: result.redirectUrl,
      orderTrackingId: result.providerOrderId,
      merchantReference: result.providerReference,
      wasMinted: true,
    };
  }

  // Loser of the UPDATE — re-SELECT to read the now-populated cache.
  const { data: row, error: selectErr } = await supabase
    .from("billing_line_items")
    .select("pesapal_redirect_url")
    .eq("id", lineItemId)
    .maybeSingle<{ pesapal_redirect_url: string | null }>();
  if (selectErr) {
    throw new PaymentError(
      `Failed to re-read billing line item: ${selectErr.message}`,
      "PAYMENT_INVALID_CONFIG",
      500,
      selectErr,
    );
  }
  if (!row || !row.pesapal_redirect_url) {
    // Should not happen — the UPDATE-NULL guard guarantees someone won and
    // persisted before we get here. Defensive: surface as invalid_config
    // rather than NPE.
    throw new PaymentError(
      "Concurrent payment-link mint race resolved to no persisted URL.",
      "PAYMENT_INVALID_CONFIG",
      500,
    );
  }
  return {
    redirectUrl: row.pesapal_redirect_url,
    orderTrackingId: null,
    merchantReference: null,
    wasMinted: false,
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensure that the given line-item has a cached Pesapal redirect URL,
 * generating + persisting one on first call. See module doc for the full
 * concurrency / cache / audit contract.
 */
export async function ensurePaymentLinkForLineItem(
  supabase: SupabaseClient,
  lineItemId: string,
  options: EnsurePaymentLinkOptions = {},
): Promise<EnsurePaymentLinkResult> {
  const force = options.force === true;

  // Operator-explicit "Regenerate" (#217) bypasses the in-memory coalescer in
  // BOTH directions: do NOT piggyback onto an in-flight tenant /pay mint, and
  // do NOT register the force-promise into the coalescer for tenant callers
  // to share. Tenant /pay callers continue to run their own UPDATE-NULL
  // guarded path; their submitOrder result becomes an orphan if the
  // operator's force UPDATE lands later, but that is the documented trade-off
  // (one tenant gets a working session for one redirect; the persisted URL
  // is the operator's fresh one).
  if (!force) {
    const existing = inflight.get(lineItemId);
    if (existing) return existing;
  }

  const promise = (async () => {
    // 1. Cache check — plain SELECT (no FOR UPDATE). Skipped under force=true:
    //    the operator's intent is "mint fresh regardless of any cached URL."
    const scope = await loadLineItemScope(supabase, lineItemId);
    if (!force && scope.pesapalRedirectUrl) {
      return {
        redirectUrl: scope.pesapalRedirectUrl,
        orderTrackingId: null,
        merchantReference: null,
        wasMinted: false,
      } satisfies EnsurePaymentLinkResult;
    }

    // 2. Mint via Pesapal + persist. force=false uses the UPDATE-NULL guard;
    //    force=true unconditionally overwrites both URL and order id.
    return mintAndPersist(
      supabase,
      lineItemId,
      { communityId: scope.communityId, currency: scope.currency },
      options,
    );
  })();

  if (!force) {
    inflight.set(lineItemId, promise);
  }
  try {
    return await promise;
  } finally {
    if (!force) {
      inflight.delete(lineItemId);
    }
  }
}

/** Test-only — drop the inflight coalescer between tests. */
export function _resetEnsurePaymentLinkCoalescerForTests(): void {
  inflight.clear();
}
