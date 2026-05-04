/**
 * POST /api/billing-line-items/[lineItemId]/url
 *
 * Generates the hosted-checkout URL for exactly one billing_line_items row.
 * Enforces "one bill, one payment link". All order fields are derived from
 * Supabase records the caller can see via RLS.
 *
 * Request body (optional, JSON):
 *   { force?: boolean }   — when true, bypass the redirect-URL cache and mint
 *                            a fresh Pesapal session. Used by the operator's
 *                            "Regenerate payment link" UI (#217). Default
 *                            false; missing/empty/`{}` body is backward-
 *                            compatible with the pre-#217 surface.
 *
 * Path chain:
 *   lineItem → billing_period → microgrid → community (provider config)
 *
 * Permission:
 *   super_admin, service_role, OR org_manager-of-owning-community can decrypt
 *   the provider secret via fn_get_community_payment_secret (#196). An
 *   org_manager of a DIFFERENT org will receive a 403 from
 *   getCommunityPaymentConfig with PAYMENT_FORBIDDEN.
 *
 * Response:
 *   200 → { redirectUrl, orderTrackingId, merchantReference }
 *   4xx/5xx → { error, reason }
 *
 * Response shape change (#202 / R5): `orderTrackingId` and `merchantReference`
 * are `string | null`. They are populated on the mint path (where we have the
 * values fresh from `submitOrder`'s response) and NULL on the cache-hit path
 * (the values are not persisted as columns on `billing_line_items`; they live
 * inside `payment_events.raw_payload`). The only UI consumer
 * (`src/components/billing/row-actions-menu.tsx`) reads only `redirectUrl`,
 * so this is non-breaking.
 *
 * Log scrubbing: the generated redirectUrl, the consumer_secret, and the
 * Pesapal session token are NEVER logged. `scrubSecretValues(..., { extra })`
 * is applied to the final log payload belt-and-suspenders — even the event
 * envelope cannot leak them.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import { PaymentError } from "@/lib/payments";
import { ensurePaymentLinkForLineItem } from "@/lib/payments/ensure-payment-link";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type LineItemScopeRow = {
  id: string;
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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> },
): Promise<NextResponse> {
  const startedAt = Date.now();
  const { lineItemId } = await params;

  if (!UUID_RE.test(lineItemId)) {
    return NextResponse.json(
      { error: "Invalid line item id — expected UUID.", reason: "bad_request" },
      { status: 400 },
    );
  }

  // Parse optional `{ force?: boolean }` body. Backwards-compatible: empty
  // body / no body / `{}` / `{ force: false }` all default to `force: false`.
  const body = (await request.json().catch(() => ({}))) as {
    force?: unknown;
  };
  const force = body?.force === true;

  const supabase = await createClient();

  // 1. Resolve lineItem → period → microgrid → community in one query.
  //    RLS applies: a line-item the user can't see surfaces as null → 404.
  //    This pre-flight runs ahead of the helper so we can still surface a
  //    "not_found" before the permission gate, AND so we can scope the log
  //    event with the resolved community/microgrid IDs.
  const { data: scoped, error: scopedErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
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

  if (scopedErr) {
    return NextResponse.json(
      { error: "Failed to look up billing line item.", reason: "unknown_error" },
      { status: 500 },
    );
  }
  if (!scoped) {
    return NextResponse.json(
      { error: "Billing line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  // PostgREST may return joined singletons as single-element arrays; normalize.
  const period = Array.isArray(scoped.billing_periods)
    ? scoped.billing_periods[0]
    : scoped.billing_periods;
  const microgrid = period
    ? Array.isArray(period.microgrids)
      ? period.microgrids[0]
      : period.microgrids
    : null;

  if (!period || !microgrid) {
    return NextResponse.json(
      { error: "Billing line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  const microgridId = period.microgrid_id;
  const communityId = microgrid.community_id;

  // Eager-resolve the authenticated user once so logPaymentEvent is synchronous.
  let actorUserId: string | null = null;
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();
    actorUserId = user?.id ?? null;
  } catch {
    actorUserId = null;
  }

  // 2. Permission gate. super_admin + org_manager-of-owning-org both allowed;
  //    cross-org callers are filtered by fn_get_community_payment_secret
  //    (cross-org org_manager → null → PAYMENT_FORBIDDEN inside the helper) (#196).
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return NextResponse.json(
      { error: "Billing line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  // 3. Delegate to the shared ensure helper. It performs the
  //    config-resolve → params-build → submitOrder → persist → audit-write
  //    flow with optimistic-concurrency on the persist.
  let result;
  try {
    result = await ensurePaymentLinkForLineItem(supabase, lineItemId, {
      actorUserId,
      force,
    });
  } catch (err) {
    const mapped = mapPaymentError(err);
    logPaymentEvent({
      communityId,
      microgridId,
      lineItemId,
      actorUserId,
      provider: null,
      status: mapped.reason,
      durationMs: Date.now() - startedAt,
      sensitive: [],
    });
    return NextResponse.json(
      { error: mapped.message, reason: mapped.reason },
      { status: mapped.httpStatus },
    );
  }

  logPaymentEvent({
    communityId,
    microgridId,
    lineItemId,
    actorUserId,
    provider: "pesapal",
    status: "success",
    durationMs: Date.now() - startedAt,
    // The redirect URL is sensitive; orderTrackingId is opaque but harmless
    // to scrub for consistency with the prior shape.
    sensitive: [
      result.redirectUrl,
      result.orderTrackingId ?? "",
    ].filter((s): s is string => Boolean(s)),
  });

  return NextResponse.json({
    redirectUrl: result.redirectUrl,
    orderTrackingId: result.orderTrackingId,
    merchantReference: result.merchantReference,
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

type MappedError = {
  message: string;
  reason: string;
  httpStatus: number;
};

/** Map PaymentError / PesapalError codes to { httpStatus, reason }. */
function mapPaymentError(err: unknown): MappedError {
  if (!(err instanceof PaymentError)) {
    return {
      message:
        "Payment link generation failed with an unexpected error. Check server logs.",
      reason: "unknown_error",
      httpStatus: 503,
    };
  }

  // Keep the message user-safe; never surface stack / details in the body.
  switch (err.code) {
    // Generic
    case "PAYMENT_NOT_CONFIGURED":
      return { message: err.message, reason: "not_configured", httpStatus: 409 };
    case "PAYMENT_FORBIDDEN":
      return { message: err.message, reason: "forbidden", httpStatus: 403 };
    case "PAYMENT_INVALID_CONFIG":
      return { message: err.message, reason: "invalid_config", httpStatus: 503 };
    case "PAYMENT_IPN_NOT_REGISTERED":
      // Post-#121: parsePesapalConfig throws this when the saved Pesapal
      // config has no `ipn_id`. Distinct from generic invalid_config so the
      // UI can render an actionable hint ("re-run Save & test connection").
      return {
        message:
          "Payment provider is configured but no IPN has been registered yet. A super admin must run Save & test connection on the Community Payment tab to register the IPN URL.",
        reason: "ipn_not_registered",
        httpStatus: 409,
      };
    case "PAYMENT_UNKNOWN_PROVIDER":
      return { message: err.message, reason: "invalid_config", httpStatus: 500 };

    // Pesapal
    case "PESAPAL_AUTH_FAILED":
      return { message: err.message, reason: "auth_failed", httpStatus: 503 };
    case "PESAPAL_UNREACHABLE":
      return { message: err.message, reason: "unreachable", httpStatus: 503 };
    case "PESAPAL_NO_IPN":
      // Legacy code retained for defense-in-depth: post-#121 parsePesapalConfig
      // rejects missing ipn_id upstream as PAYMENT_IPN_NOT_REGISTERED, so this
      // branch is unreachable in practice. Mapped to the same 409 reason for
      // consistency if it ever fires.
      return {
        message:
          "Payment provider is configured but no IPN has been registered yet. A super admin must run Save & test connection on the Community Payment tab to register the IPN URL.",
        reason: "ipn_not_registered",
        httpStatus: 409,
      };
    case "PESAPAL_REGISTER_IPN_FAILED":
      return { message: err.message, reason: "register_ipn_failed", httpStatus: 503 };
    case "PESAPAL_INVALID_CONFIG":
      return { message: err.message, reason: "invalid_config", httpStatus: 503 };
    case "PESAPAL_MISSING_CONTACT":
      return { message: err.message, reason: "missing_contact", httpStatus: 400 };
    case "PESAPAL_ZERO_AMOUNT":
      return { message: err.message, reason: "zero_amount", httpStatus: 400 };
    case "PESAPAL_LINE_ITEM_NOT_FOUND":
    case "PESAPAL_PERIOD_NOT_FOUND":
    case "PESAPAL_HOUSEHOLD_NOT_FOUND":
      return { message: err.message, reason: "not_found", httpStatus: 404 };
    case "PESAPAL_NO_REDIRECT":
    case "PESAPAL_HTTP_ERROR":
      return { message: err.message, reason: "unknown_error", httpStatus: 503 };
    default:
      return { message: err.message, reason: "unknown_error", httpStatus: 503 };
  }
}

function logPaymentEvent(args: {
  communityId: string;
  microgridId: string;
  lineItemId: string;
  actorUserId: string | null;
  provider: string | null;
  status: string;
  durationMs: number;
  sensitive: string[];
}): void {
  const payload = {
    event: "payment.generate_link",
    community_id: args.communityId,
    microgrid_id: args.microgridId,
    line_item_id: args.lineItemId,
    actor_user_id: args.actorUserId,
    provider: args.provider,
    status: args.status,
    duration_ms: args.durationMs,
    at: new Date().toISOString(),
  };

  const scrubbed = scrubSecretValues(payload, {
    extra: args.sensitive.filter(Boolean),
  });
  console.info(JSON.stringify(scrubbed));
}
