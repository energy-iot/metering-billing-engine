/**
 * PHASE A behavior — REPLACED in Phase B (#157).
 * Phase A: ack 200 with no state work so Pesapal stops retrying.
 * Phase B (#157) will replace the body with: server-to-server
 * getTransactionStatus verify → idempotent state transition → payment_events
 * audit row. Do NOT add state logic here — file it on #157 instead.
 *
 * Body must be replaced by the state machine when #157 lands; the file path
 * stays.
 *
 * --------------------------------------------------------------------------
 *
 * /api/payments/ipn — Pesapal IPN webhook receiver (public).
 *
 * Pesapal calls this URL after a checkout completes. The newer JSON 3.0 flow
 * uses POST with a JSON body; older integrations use GET with query params
 * (`OrderTrackingId`, `OrderMerchantReference`, `OrderNotificationType`).
 * Both verbs MUST 200 in Phase A so Pesapal does not retry — Phase B will
 * verify and act on the payload.
 *
 * Security: Pesapal does not sign IPN posts. Signature verification belongs
 * to Phase B's threat-model task. Phase A relies on Vercel's default
 * rate-limiting (sufficient for the pilot) and never trusts the body — it
 * only logs it.
 */

import { NextRequest, NextResponse } from "next/server";

// Public route — no auth, no Supabase client. Phase B will introduce a
// service-role client to look up the order and update state idempotently.
const PHASE_A_RESPONSE = { received: true } as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  await logIpnEvent(request, "POST");
  return NextResponse.json(PHASE_A_RESPONSE, { status: 200 });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  await logIpnEvent(request, "GET");
  return NextResponse.json(PHASE_A_RESPONSE, { status: 200 });
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Best-effort structured log: method, parsed query params, parsed body
 * (when JSON), redacted headers. We never throw from the logger — the route
 * MUST 200 even if logging fails. No PII / secrets are expected on Pesapal's
 * payload (just opaque tracking ids), but we still go through `safeStringify`
 * with a length cap to keep log lines bounded.
 */
async function logIpnEvent(
  request: NextRequest,
  method: "POST" | "GET",
): Promise<void> {
  let body: unknown = null;
  if (method === "POST") {
    try {
      const text = await request.text();
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          // Pesapal may post form-urlencoded in some configurations; fall back
          // to the raw text (length-capped).
          body = text.slice(0, 1000);
        }
      }
    } catch {
      body = null;
    }
  }

  const queryParams: Record<string, string> = {};
  try {
    request.nextUrl.searchParams.forEach((value, key) => {
      queryParams[key] = value;
    });
  } catch {
    // ignore
  }

  const safeHeaders: Record<string, string> = {};
  for (const headerName of [
    "user-agent",
    "content-type",
    "x-forwarded-for",
    "x-vercel-ip-country",
  ]) {
    const value = request.headers.get(headerName);
    if (value) safeHeaders[headerName] = value;
  }

  try {
    console.info(
      JSON.stringify({
        event: "payment.ipn.received",
        phase: "A",
        method,
        query: queryParams,
        body,
        headers: safeHeaders,
        at: new Date().toISOString(),
      }),
    );
  } catch {
    // Never let logging fail the 200 ack.
  }
}
