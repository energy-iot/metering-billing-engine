/**
 * POST /api/billing-line-items/[lineItemId]/url
 *
 * Generates the Pesapal hosted-checkout URL for exactly one bill (one
 * billing_line_items row). Enforces the product rule: one bill, one payment
 * link.
 *
 * All order fields are derived server-side from Supabase records the caller
 * has access to via RLS — the request body is ignored. This keeps callers from
 * minting a link with an amount or recipient different from what's stored.
 *
 *   amount         ← billing_line_items.total_amount
 *   description    ← period date range joined through billing_periods
 *   billingAddress ← tenant row named on the line item
 *
 * Response:
 *   200: { redirectUrl, orderTrackingId, merchantReference }
 *   4xx/5xx: { error, code? }
 */

import { NextResponse } from "next/server";
import { createPaymentOrder, PesapalError } from "@/lib/pesapal";
import { buildOrderParamsFromLineItem } from "@/lib/pesapal/build-params";
import { createClient } from "@/lib/supabase/server";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ lineItemId: string }> },
) {
  const { lineItemId } = await params;

  // Pesapal rejects reused `id` values (returns the cached order) — append a
  // timestamp so every click generates a fresh submission.
  const orderId = `INV-${lineItemId}-${Date.now()}`;

  try {
    const supabase = await createClient();
    const { params: built } = await buildOrderParamsFromLineItem(
      supabase,
      lineItemId,
    );

    const resp = await createPaymentOrder({
      id: orderId,
      ...built,
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
    console.error("[billing-line-items/url] unexpected error:", err);
    return NextResponse.json(
      { error: "Unexpected error creating payment URL" },
      { status: 500 },
    );
  }
}
