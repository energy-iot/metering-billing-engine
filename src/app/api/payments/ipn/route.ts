/**
 * /api/payments/ipn — Pesapal IPN webhook receiver (PHASE B — #157).
 *
 * Pesapal POSTs / GETs this URL after a hosted-checkout completes (success,
 * failure, or reversal). Phase A (#121) registered the URL and acked 200;
 * Phase B re-queries Pesapal via `getTransactionStatus` (server-to-server,
 * the body is untrusted) and applies the canonical state transition through
 * the authoritative `fn_apply_payment_event` SQL function.
 *
 * Hard invariant: this route ALWAYS returns HTTP 200, regardless of the
 * outcome — verify failed, unknown order id, RPC error, anything. Pesapal
 * retries indefinitely on non-2xx. The webhook is the integration's
 * eventually-consistent feed; if a single delivery is dropped, Pesapal will
 * retry. We rely on idempotent dedup (60s window inside the SQL function)
 * to keep the audit trail clean.
 *
 * Security: Pesapal does not sign IPN posts. The body is treated as a hint
 * — only `OrderTrackingId` and `OrderMerchantReference` are extracted, and
 * the actual state determination comes from the server-to-server callback.
 *
 * RLS: this is a public route — no user session. Lookups use a service-role
 * client via `createServiceClient()` (RLS bypass) so we can resolve the
 * line item even though the webhook is unauthenticated. The state-mutating
 * call goes through `fn_apply_payment_event` (SECURITY DEFINER).
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceClient } from "@/lib/supabase/service";
import { PesapalClient } from "@/lib/payments/pesapal/client";
import { parsePesapalConfig } from "@/lib/payments/config";
import { PaymentError } from "@/lib/payments/errors";
import { PesapalError } from "@/lib/payments/pesapal/errors";
import type { GetTransactionStatusResponse } from "@/lib/payments/pesapal/types";
import type { PaymentStatus } from "@/lib/payments/state";

// Public route — always 200. Any internal failure is logged and absorbed.
const ACK_RESPONSE = { received: true } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  await handleWebhook(request, "POST");
  return NextResponse.json(ACK_RESPONSE, { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  await handleWebhook(request, "GET");
  return NextResponse.json(ACK_RESPONSE, { status: 200 });
}

// ─── core handler ──────────────────────────────────────────────────────────

async function handleWebhook(
  request: NextRequest,
  method: "POST" | "GET",
): Promise<void> {
  // 1. Extract the two ids from query (legacy GET) or body (modern POST).
  let orderTrackingId: string | null = null;
  let merchantReference: string | null = null;

  try {
    request.nextUrl.searchParams.forEach((value, key) => {
      if (key === "OrderTrackingId" || key === "orderTrackingId") {
        orderTrackingId = value;
      } else if (
        key === "OrderMerchantReference" ||
        key === "merchantReference"
      ) {
        merchantReference = value;
      }
    });
  } catch {
    // ignore — falls through to body parse.
  }

  if (method === "POST") {
    try {
      const text = await request.text();
      if (text.length > 0) {
        try {
          const body = JSON.parse(text) as Record<string, unknown>;
          if (typeof body === "object" && body !== null) {
            if (!orderTrackingId && typeof body.OrderTrackingId === "string") {
              orderTrackingId = body.OrderTrackingId;
            }
            if (
              !merchantReference &&
              typeof body.OrderMerchantReference === "string"
            ) {
              merchantReference = body.OrderMerchantReference;
            }
            if (!orderTrackingId && typeof body.orderTrackingId === "string") {
              orderTrackingId = body.orderTrackingId as string;
            }
            if (
              !merchantReference &&
              typeof body.merchantReference === "string"
            ) {
              merchantReference = body.merchantReference as string;
            }
          }
        } catch {
          // body wasn't JSON — log and ack. Pesapal occasionally posts
          // form-urlencoded; the same fields show up on the query path.
        }
      }
    } catch {
      // unreadable body — ack 200.
    }
  }

  // Always log the receipt with the ids we found (or didn't).
  const logBase = {
    event: "payment.ipn.received",
    phase: "B",
    method,
    order_tracking_id: orderTrackingId,
    merchant_reference: merchantReference,
    at: new Date().toISOString(),
  };

  if (!orderTrackingId || !merchantReference) {
    safeInfo({ ...logBase, status: "missing_ids" });
    return;
  }

  // 2. Resolve the line item by merchantReference (= pesapal_order_id).
  const supabase = createServiceClient();

  type ScopedRow = {
    id: string;
    payment_status: PaymentStatus;
    billing_period_id: string;
    billing_periods:
      | {
          microgrid_id: string;
          microgrids:
            | {
                community_id: string;
              }
            | null;
        }
      | null;
  };

  const { data: scoped, error: scopedErr } = await supabase
    .from("billing_line_items")
    .select(
      `
      id,
      payment_status,
      billing_period_id,
      billing_periods!inner (
        microgrid_id,
        microgrids!inner (
          community_id
        )
      )
    `,
    )
    .eq("pesapal_order_id", merchantReference)
    .maybeSingle<ScopedRow>();

  if (scopedErr) {
    safeWarn({ ...logBase, status: "lookup_failed", message: scopedErr.message });
    return;
  }
  if (!scoped) {
    safeInfo({ ...logBase, status: "unknown_order" });
    return;
  }

  const period = Array.isArray(scoped.billing_periods)
    ? scoped.billing_periods[0]
    : scoped.billing_periods;
  const microgrid = period
    ? Array.isArray(period.microgrids)
      ? period.microgrids[0]
      : period.microgrids
    : null;

  if (!period || !microgrid) {
    safeWarn({ ...logBase, status: "scope_join_missing" });
    return;
  }

  const communityId = microgrid.community_id;

  // 3. Load community payment config (config + decrypted secret) so we can
  //    call Pesapal getTransactionStatus. Service-role bypasses RLS; the
  //    secret is decrypted via fn_get_community_payment_secret.
  const { data: communityRow, error: communityErr } = await supabase
    .from("communities")
    .select("id, payment_provider, payment_provider_config")
    .eq("id", communityId)
    .maybeSingle<{
      id: string;
      payment_provider: "pesapal" | null;
      payment_provider_config: unknown;
    }>();

  if (communityErr || !communityRow) {
    safeWarn({
      ...logBase,
      status: "community_not_found",
      community_id: communityId,
      message: communityErr?.message,
    });
    return;
  }
  if (communityRow.payment_provider !== "pesapal") {
    safeWarn({
      ...logBase,
      status: "provider_not_pesapal",
      community_id: communityId,
    });
    return;
  }

  let parsedConfig;
  try {
    parsedConfig = parsePesapalConfig(communityRow.payment_provider_config);
  } catch (err) {
    safeWarn({
      ...logBase,
      status: "invalid_config",
      community_id: communityId,
      message: err instanceof PaymentError ? err.code : String(err),
    });
    return;
  }

  const { data: secret, error: secretErr } = await supabase.rpc(
    "fn_get_community_payment_secret",
    { _community_id: communityId },
  );
  if (secretErr || !secret) {
    safeWarn({
      ...logBase,
      status: "secret_missing",
      community_id: communityId,
      message: secretErr?.message,
    });
    return;
  }

  // 4. Server-to-server verify.
  const client = new PesapalClient({
    consumerKey: parsedConfig.consumer_key,
    consumerSecret: secret as string,
    baseUrl: parsedConfig.base_url,
  });

  let verifyResponse: GetTransactionStatusResponse;
  try {
    const token = await client.getAccessToken();
    verifyResponse = await client.getTransactionStatus(
      token,
      orderTrackingId,
    );
  } catch (err) {
    // PESAPAL_UNREACHABLE / PESAPAL_AUTH_FAILED / PESAPAL_HTTP_ERROR — ack 200,
    // Pesapal will retry. We rely on Pesapal's own retry policy.
    safeWarn({
      ...logBase,
      status: "verify_failed",
      community_id: communityId,
      pesapal_code: err instanceof PesapalError ? err.code : "unknown",
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // 5. Map Pesapal status → MBE state.
  const desc = (verifyResponse.payment_status_description ?? "")
    .trim()
    .toUpperCase();
  let toStatus: PaymentStatus | null = null;
  if (desc === "COMPLETED") toStatus = "paid";
  else if (desc === "FAILED") toStatus = "failed";
  else if (desc === "REVERSED") toStatus = "refunded";
  // PENDING / INVALID / unknown → no-op.

  if (!toStatus) {
    safeInfo({
      ...logBase,
      status: "noop",
      community_id: communityId,
      pesapal_status: desc || null,
    });
    return;
  }

  // 6. Apply via the authoritative state-machine RPC. This is a no-op when
  //    the line item is already in `to_status` (idempotent re-delivery).
  //    `_actor_user_id` is NULL for IPN (no user session).
  const rawPayload = {
    order_tracking_id: orderTrackingId,
    merchant_reference: merchantReference,
    payment_status_description: verifyResponse.payment_status_description,
    payment_method: verifyResponse.payment_method,
    amount: verifyResponse.amount,
    currency: verifyResponse.currency,
    confirmation_code: verifyResponse.confirmation_code,
  };

  const { error: rpcErr } = await supabase.rpc("fn_apply_payment_event", {
    _line_item_id: scoped.id,
    _to_status: toStatus,
    _source: "ipn",
    _actor_user_id: null,
    _raw_payload: rawPayload,
  });

  if (rpcErr) {
    // Possible race or invalid_transition — log loudly but always 200.
    safeWarn({
      ...logBase,
      status: "rpc_failed",
      community_id: communityId,
      from_status: scoped.payment_status,
      to_status: toStatus,
      pg_code: rpcErr.code,
      message: rpcErr.message,
    });
    return;
  }

  safeInfo({
    ...logBase,
    status: "applied",
    community_id: communityId,
    line_item_id: scoped.id,
    from_status: scoped.payment_status,
    to_status: toStatus,
    pesapal_status: desc,
  });
}

// ─── logging helpers ───────────────────────────────────────────────────────

function safeInfo(payload: Record<string, unknown>): void {
  try {
    console.info(JSON.stringify(payload));
  } catch {
    // never throw from the logger.
  }
}

function safeWarn(payload: Record<string, unknown>): void {
  try {
    console.warn(JSON.stringify(payload));
  } catch {
    // never throw from the logger.
  }
}
