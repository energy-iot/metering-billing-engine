/**
 * POST /api/billing/[periodId]/url
 *
 * Runs the Pesapal three-step flow (auth → IPN list → SubmitOrderRequest)
 * and returns the hosted-checkout redirect URL for the given billing period.
 *
 * Real data comes from Supabase via `buildOrderParamsFromPeriod`:
 *   - amount         = sum of billing_line_items.total_amount for this period
 *   - description    = "Utility bill for <date range>"
 *   - billingAddress = the first tenant with a line item (fallback: oldest
 *                      tenant in the microgrid), split name + email/phone
 *
 * Body is optional — any field provided overrides the Supabase-derived value.
 * This lets other components on the billing page contribute params (e.g. a
 * custom description or callback URL) without re-implementing the lookup.
 *
 *   {
 *     amount?: number,
 *     description?: string,
 *     callbackUrl?: string,
 *     billingAddress?: {
 *       email_address?: string,
 *       phone_number?: string,
 *       first_name?: string,
 *       last_name?: string,
 *     },
 *   }
 *
 * Response:
 *   200: { redirectUrl, orderTrackingId, merchantReference }
 *   4xx/5xx: { error, code? }
 */

import { NextRequest, NextResponse } from "next/server";
import {
  createPaymentOrder,
  PesapalError,
  type BillingAddress,
} from "@/lib/pesapal";
import { buildOrderParamsFromPeriod } from "@/lib/pesapal/build-params";
import { createClient } from "@/lib/supabase/server";

type RequestBody = {
  amount?: number;
  description?: string;
  callbackUrl?: string;
  billingAddress?: BillingAddress;
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ periodId: string }> },
) {
  const { periodId } = await params;

  let body: RequestBody = {};
  try {
    // Body is optional; ignore parse errors from empty/invalid JSON.
    const text = await request.text();
    if (text.trim().length > 0) body = JSON.parse(text) as RequestBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON body" },
      { status: 400 },
    );
  }

  // Pesapal rejects reused `id` values (returns the cached order) — append a
  // timestamp so every click generates a fresh submission.
  const orderId = `INV-${periodId}-${Date.now()}`;

  try {
    const supabase = await createClient();
    const { params: built } = await buildOrderParamsFromPeriod(
      supabase,
      periodId,
    );

    const resp = await createPaymentOrder({
      id: orderId,
      amount: body.amount ?? built.amount,
      description: body.description ?? built.description,
      callbackUrl: body.callbackUrl ?? built.callbackUrl,
      billingAddress: body.billingAddress ?? built.billingAddress,
      // currency omitted → defaults to "UGX" inside createPaymentOrder
    });

    if (!resp.redirect_url) {
      return NextResponse.json(
        {
          error: "Pesapal did not return a redirect_url",
          code: "PESAPAL_NO_REDIRECT",
          details: resp,
        },
        { status: 502 },
      );
    }

    return NextResponse.json({
      redirectUrl: resp.redirect_url,
      orderTrackingId: resp.order_tracking_id,
      merchantReference: resp.merchant_reference,
    });
  } catch (err) {
    if (err instanceof PesapalError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.statusCode },
      );
    }
    console.error("[billing/url] unexpected error:", err);
    return NextResponse.json(
      { error: "Unexpected error creating payment URL" },
      { status: 500 },
    );
  }
}
