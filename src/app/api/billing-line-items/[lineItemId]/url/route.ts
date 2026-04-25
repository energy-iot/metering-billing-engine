/**
 * POST /api/billing-line-items/[lineItemId]/url
 *
 * Generates the hosted-checkout URL for exactly one billing_line_items row.
 * Enforces "one bill, one payment link". All order fields are derived from
 * Supabase records the caller can see via RLS — the request body is ignored.
 *
 * Path chain:
 *   lineItem → billing_period → microgrid → community (provider config)
 *
 * Permission:
 *   Both super_admin AND org_manager may trigger link generation. Only super_admin
 *   (or service_role) can decrypt the provider secret via
 *   fn_get_community_payment_secret; an org_manager of the owning community
 *   will receive a 403 from getCommunityPaymentConfig with PAYMENT_FORBIDDEN.
 *
 * Response:
 *   200 → { redirectUrl, orderTrackingId, merchantReference }
 *   4xx/5xx → { error, reason }
 *
 * Log scrubbing: the generated redirectUrl, the consumer_secret, and the
 * Pesapal session token are NEVER logged. `scrubSecretValues(..., { extra })`
 * is applied to the final log payload belt-and-suspenders — even the event
 * envelope cannot leak them.
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { currentUserCanAccessMicrogrid } from "@/lib/auth/access";
import {
  PaymentError,
  getPaymentProviderClient,
  type GeneratePaymentLinkResult,
} from "@/lib/payments";
import { getCommunityPaymentConfig } from "@/lib/payments/config";
import { buildOrderParamsFromLineItem } from "@/lib/payments/pesapal/build-params";
import { buildOrderId } from "@/lib/payments/pesapal/order-id";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DEFAULT_CALLBACK_URL =
  process.env.NEXT_PUBLIC_PAYMENT_CALLBACK_URL ??
  "http://localhost:3000/payment/callback";

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
  _request: NextRequest,
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

  const supabase = await createClient();

  // 1. Resolve lineItem → period → microgrid → community in one query.
  //    RLS applies: a line-item the user can't see surfaces as null → 404.
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

  // 2. Permission gate. org_manager + super_admin both allowed; secret access
  //    is filtered by fn_get_community_payment_secret (org_manager → null →
  //    PAYMENT_FORBIDDEN below).
  if (!(await currentUserCanAccessMicrogrid(supabase, microgridId))) {
    return NextResponse.json(
      { error: "Billing line item not found.", reason: "not_found" },
      { status: 404 },
    );
  }

  // 3. Load payment config for the community.
  let paymentConfig;
  try {
    paymentConfig = await getCommunityPaymentConfig(supabase, communityId);
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

  if (!paymentConfig) {
    logPaymentEvent({
      communityId,
      microgridId,
      lineItemId,
      actorUserId,
      provider: null,
      status: "not_configured",
      durationMs: Date.now() - startedAt,
      sensitive: [],
    });
    return NextResponse.json(
      {
        error: "No payment provider configured for this community.",
        reason: "not_configured",
      },
      { status: 409 },
    );
  }

  // 4. Build the per-line-item order params.
  let built;
  try {
    built = await buildOrderParamsFromLineItem(supabase, lineItemId);
  } catch (err) {
    const mapped = mapPaymentError(err);
    logPaymentEvent({
      communityId,
      microgridId,
      lineItemId,
      actorUserId,
      provider: paymentConfig.provider,
      status: mapped.reason,
      durationMs: Date.now() - startedAt,
      sensitive: [paymentConfig.secret],
    });
    return NextResponse.json(
      { error: mapped.message, reason: mapped.reason },
      { status: mapped.httpStatus },
    );
  }

  // 5. Currency: prefer microgrid.currency; fall back to UGX with a warning.
  let currency = microgrid.currency ?? "";
  if (!currency) {
    console.warn(
      JSON.stringify({
        event: "payment.generate_link.currency_fallback",
        microgrid_id: microgridId,
        fallback: "UGX",
        at: new Date().toISOString(),
      }),
    );
    currency = "UGX";
  }

  // 6. Pesapal rejects reused `id` — fresh per click. Pesapal caps `id` at
  //    50 chars; `buildOrderId` encodes the UUID as crockford-base32 so the
  //    composed id stays at 44 chars. See src/lib/payments/pesapal/order-id.ts.
  const orderId = buildOrderId(lineItemId);

  // 7. Dispatch through the factory. The PesapalProvider constructor itself
  //    throws PESAPAL_NO_IPN when the persisted config lacks ipn_id (a
  //    per-#119 deferred-IPN state). Wrap both the constructor and the
  //    generatePaymentLink call under a single try so every Pesapal-layer
  //    error lands in the same mapPaymentError branch.
  let result: GeneratePaymentLinkResult;
  try {
    const client = getPaymentProviderClient(paymentConfig);
    result = await client.generatePaymentLink({
      lineItemId,
      orderId,
      amount: built.amount,
      description: built.description,
      billingAddress: built.billingAddress,
      callbackUrl: DEFAULT_CALLBACK_URL,
      currency,
    });
  } catch (err) {
    const mapped = mapPaymentError(err);
    logPaymentEvent({
      communityId,
      microgridId,
      lineItemId,
      actorUserId,
      provider: paymentConfig.provider,
      status: mapped.reason,
      durationMs: Date.now() - startedAt,
      sensitive: [paymentConfig.secret],
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
    provider: paymentConfig.provider,
    status: "success",
    durationMs: Date.now() - startedAt,
    sensitive: [paymentConfig.secret, result.redirectUrl, result.providerOrderId],
  });

  return NextResponse.json({
    redirectUrl: result.redirectUrl,
    orderTrackingId: result.providerOrderId,
    merchantReference: result.providerReference,
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
    case "PAYMENT_UNKNOWN_PROVIDER":
      return { message: err.message, reason: "invalid_config", httpStatus: 500 };

    // Pesapal
    case "PESAPAL_AUTH_FAILED":
      return { message: err.message, reason: "auth_failed", httpStatus: 503 };
    case "PESAPAL_UNREACHABLE":
      return { message: err.message, reason: "unreachable", httpStatus: 503 };
    case "PESAPAL_NO_IPN":
      // Per #119 AC-LIB-2: community has a provider configured but no IPN
      // registered yet — a user-caused not-ready state distinct from the
      // malformed/invalid (503) case. 409 signals "config exists but link
      // generation is gated on IPN registration (ships with #121)".
      return {
        message:
          "Payment provider is configured but no IPN has been registered yet. A super admin must complete IPN registration before links can be generated.",
        reason: "invalid_config",
        httpStatus: 409,
      };
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
