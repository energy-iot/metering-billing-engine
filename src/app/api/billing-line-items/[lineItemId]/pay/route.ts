/**
 * GET /api/billing-line-items/[lineItemId]/pay
 *
 * Public, stable redirect URL embedded in the consumer-facing PDF invoice
 * (#202 / D6). The customer (Aaron's tenant) clicks the link in WhatsApp
 * and lands here; this route 302s them to the cached Pesapal hosted-checkout
 * URL, minting one on first call if necessary.
 *
 *   - NO session auth (the line-item ID is the access token; UUID v4 entropy
 *     + IP rate-limit defends against scraping).
 *   - Service-role Supabase client (RLS bypassed by design).
 *   - 10 req/min per IP via in-memory sliding window. Per-Vercel-instance,
 *     not cluster-wide; defends against accidental scraping but a coordinated
 *     attacker across instances bypasses it. A future ticket can swap in
 *     Upstash / Vercel KV when abuse signal appears (the call site only
 *     depends on `checkRateLimit(...)`'s contract).
 *
 * Status-code map (RFC 7231-aligned):
 *
 *   | Condition                                              | Status | Body                          |
 *   |--------------------------------------------------------|--------|-------------------------------|
 *   | Happy path                                             | 302    | Redirect to Pesapal URL       |
 *   | Line item not found (PESAPAL_LINE_ITEM_NOT_FOUND)      | 404    | HTML "not available"          |
 *   | Community has no payment provider (PAYMENT_NOT_CONFIG) | 409    | HTML "not configured"         |
 *   | Any other PaymentError (Pesapal upstream / auth / etc) | 502    | HTML "could not be retrieved" |
 *   | Rate-limit exceeded                                    | 429    | "Too many requests" + Retry-After |
 *
 *   "Soft-deleted" is NOT a case — `billing_line_items` has no soft-delete
 *   column (verified at 00001_schema.sql:237-248). Hard-deletes cascade from
 *   `billing_periods.ON DELETE CASCADE` and surface here as 404.
 *
 * Audit logging: every hit writes a structured log line via
 * `scrubSecretValues(payload, { extra: [redirectUrl].filter(Boolean) })` so
 * the persisted Pesapal URL never lands in stdout. The log includes the
 * truncated IP, line_item_id, and outcome (302 / 404 / 409 / 502 / 429).
 */

import { NextRequest, NextResponse } from "next/server";

import { PaymentError } from "@/lib/payments";
import { ensurePaymentLinkForLineItem } from "@/lib/payments/ensure-payment-link";
import { createServiceClient } from "@/lib/supabase/service";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";
import { checkRateLimit } from "@/lib/rate-limit/in-memory";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RATE_LIMIT_PER_MIN = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ lineItemId: string }> },
): Promise<Response> {
  const startedAt = Date.now();
  const { lineItemId } = await params;

  const ipFull = readClientIp(request);

  if (!UUID_RE.test(lineItemId)) {
    logPayEvent({
      lineItemId,
      ipTruncated: truncateIp(ipFull),
      outcome: "400",
      durationMs: Date.now() - startedAt,
    });
    return htmlResponse(
      400,
      "Invalid request",
      "The link you used isn't valid. Please contact your operator.",
    );
  }

  // ── Rate limit ──────────────────────────────────────────────────────────
  const rl = checkRateLimit(ipFull, RATE_LIMIT_PER_MIN, RATE_LIMIT_WINDOW_MS);
  if (!rl.ok) {
    logPayEvent({
      lineItemId,
      ipTruncated: truncateIp(ipFull),
      outcome: "429",
      durationMs: Date.now() - startedAt,
    });
    return new NextResponse(
      htmlBody(
        "Too many requests",
        "You've made too many requests in a short window. Please try again in a moment.",
      ),
      {
        status: 429,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Retry-After": String(rl.retryAfter ?? 60),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  // ── Helper delegation ───────────────────────────────────────────────────
  const supabase = createServiceClient();
  let result;
  try {
    result = await ensurePaymentLinkForLineItem(supabase, lineItemId, {
      // Public endpoint — no session, no auth.uid().
      actorUserId: null,
    });
  } catch (err) {
    return handleError(err, {
      lineItemId,
      ipTruncated: truncateIp(ipFull),
      startedAt,
    });
  }

  logPayEvent({
    lineItemId,
    ipTruncated: truncateIp(ipFull),
    outcome: "302",
    durationMs: Date.now() - startedAt,
    redirectUrl: result.redirectUrl,
  });

  // 302 redirect with no-store so the URL never gets cached by intermediate
  // proxies or the browser. Pesapal session URLs are sensitive even in our
  // "stable redirect" model — the *MBE* URL is stable; the *Pesapal* URL it
  // resolves to is one-shot-ish.
  return NextResponse.redirect(result.redirectUrl, {
    status: 302,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

// ─── error mapping ──────────────────────────────────────────────────────────

function handleError(
  err: unknown,
  ctx: { lineItemId: string; ipTruncated: string; startedAt: number },
): Response {
  const isPaymentErr = err instanceof PaymentError;
  let status = 502;
  let title = "Payment link unavailable";
  let body =
    "Payment link could not be retrieved — please contact your operator.";

  if (isPaymentErr) {
    if (err.code === "PESAPAL_LINE_ITEM_NOT_FOUND") {
      status = 404;
      title = "Bill not found";
      body =
        "This bill is not available — please contact your operator.";
    } else if (err.code === "PAYMENT_NOT_CONFIGURED") {
      status = 409;
      title = "Online payment unavailable";
      body =
        "Online payment is not configured for this community. Please contact your operator.";
    }
    // Every other PaymentError code falls through to the 502 default
    // ("upstream failed"). We deliberately do NOT surface 403 / 503 / 400
    // mappings used by the operator-facing /url route — public callers get
    // the same opaque "couldn't retrieve" page regardless of the upstream
    // error class. The scrubbed log captures the actual code.
  }

  // Server-side logging — keep error.code visible for operators but never
  // leak the message body to the public response.
  console.warn(
    JSON.stringify({
      event: "payment.pay_redirect.error",
      line_item_id: ctx.lineItemId,
      ip_truncated: ctx.ipTruncated,
      err_code: isPaymentErr ? err.code : "unknown",
      err_message: isPaymentErr ? err.message : "(non-PaymentError)",
      at: new Date().toISOString(),
    }),
  );

  logPayEvent({
    lineItemId: ctx.lineItemId,
    ipTruncated: ctx.ipTruncated,
    outcome: String(status),
    durationMs: Date.now() - ctx.startedAt,
  });

  return htmlResponse(status, title, body);
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Read client IP from headers. Next.js 16's NextRequest does NOT expose `.ip`
 * (verified at node_modules/next/dist/server/web/spec-extension/request.d.ts).
 * Read x-forwarded-for, then x-real-ip, then fall back to the literal
 * 'unknown'.
 */
function readClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    // First comma-separated hop is the client.
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/**
 * Truncate IPv4 to /24 (zero last octet) and IPv6 to /48 for the audit log.
 * The rate-limit key uses the full IP — only the audit log gets the
 * truncated form.
 */
function truncateIp(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  // IPv4: a.b.c.d → a.b.c.0
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  // IPv6: keep first 3 hextets (≈ /48) and zero the rest.
  if (ip.includes(":")) {
    // Normalize :: by splitting carefully; we just want a coarse /48 form.
    const parts = ip.split(":");
    const head = parts.slice(0, 3).join(":");
    return `${head}::/48`;
  }
  return ip;
}

function htmlBody(title: string, message: string): string {
  // Minimal, dependency-free HTML. No styles to keep payload small and
  // avoid leaking design system into a public-facing error surface.
  // Title/message are NEVER user-supplied — escaping omitted intentionally.
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "</head>",
    "<body>",
    `<h1>${title}</h1>`,
    `<p>${message}</p>`,
    "</body>",
    "</html>",
  ].join("\n");
}

function htmlResponse(status: number, title: string, message: string): Response {
  return new NextResponse(htmlBody(title, message), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function logPayEvent(args: {
  lineItemId: string;
  ipTruncated: string;
  outcome: string;
  durationMs: number;
  redirectUrl?: string;
}): void {
  const payload = {
    event: "payment.pay_redirect",
    line_item_id: args.lineItemId,
    ip_truncated: args.ipTruncated,
    outcome: args.outcome,
    duration_ms: args.durationMs,
    at: new Date().toISOString(),
  };
  const scrubbed = scrubSecretValues(payload, {
    extra: args.redirectUrl ? [args.redirectUrl] : [],
  });
  console.info(JSON.stringify(scrubbed));
}
