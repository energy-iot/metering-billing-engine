/**
 * GET /p/[slug]
 *
 * Customer-facing short-URL indirection (#223). The PDF bill embeds
 * `${origin}/p/<6-8 char base62>`; the customer clicks from WhatsApp (no
 * session); we resolve the slug to a line_item_id via service-role SELECT
 * and 302 to `/api/billing-line-items/<id>/pay`, where the existing flow
 * (rate-limit, ensure-payment-link, Pesapal session redirect) takes over.
 *
 * Why a separate route (vs. embedding the slug-resolve inside /pay)?
 *   - Keeps the legacy `/api/billing-line-items/<uuid>/pay` route 100%
 *     unchanged — bills already shipped to customer WhatsApp threads
 *     reference the long URL and depend on its exact behavior.
 *   - Centralizes the "slug is the access token" semantics here. The /pay
 *     route already documents "line-item ID is the access token".
 *
 * Why a RELATIVE Location header (not absolute via resolveOrigin)?
 *   Same-origin redirect → no host-spoofing surface, no risk of leaking
 *   the request's host header into the response. Vercel preserves the
 *   incoming Host on relative redirects. This is a deliberate divergence
 *   from `pay/route.ts:128`, which 302s to a Pesapal-hosted absolute URL.
 *
 * Rate limit: delegates entirely to `/pay`'s existing 10-req/min/IP sliding
 * window. The customer browser consumes our 302, then issues a new request
 * to `/pay` from the same IP — one customer click = one /pay hit. Adding a
 * second limiter here would double-count and add no defense in depth.
 *
 * Cache-Control: no-store on every response (302 / 404 / 400). Mirrors
 * `pay/route.ts` — defends against any intermediate proxy caching the slug
 * → /pay redirect.
 *
 * Status-code map:
 *
 *   | Condition           | Status | Body                            |
 *   |---------------------|--------|---------------------------------|
 *   | Happy path          | 302    | Location: /api/billing-line-items/<id>/pay |
 *   | Bad slug shape      | 400    | HTML "Invalid request"          |
 *   | Slug not found      | 404    | HTML "Bill not found"           |
 *   | Service-role error  | 500    | HTML "Unexpected error"         |
 *
 * Audit logging mirrors `pay/route.ts`'s shape at
 * `event=payment.short_slug.received` with outcomes
 * `redirected | not_found | bad_shape | error`.
 */

import { NextRequest, NextResponse } from "next/server";

import { createServiceClient } from "@/lib/supabase/service";
import { scrubSecretValues } from "@/lib/logging/scrub-secrets";

// Match the CHECK regex in 00038_billing_line_items_short_slug.sql.
const SLUG_RE = /^[A-Za-z0-9]{6,8}$/;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const startedAt = Date.now();
  const { slug } = await params;

  const ipFull = readClientIp(request);
  const ipTruncated = truncateIp(ipFull);

  // 1. Defense-in-depth shape check before hitting the DB. The column CHECK
  //    enforces it too, but a malformed slug should 400 cheaply.
  if (!SLUG_RE.test(slug)) {
    logShortSlugEvent({
      slug,
      ipTruncated,
      outcome: "bad_shape",
      durationMs: Date.now() - startedAt,
    });
    return htmlResponse(
      400,
      "Invalid request",
      "The link you used isn't valid. Please contact your operator.",
    );
  }

  // 2. Service-role SELECT — slug IS the access token, mirroring how the
  //    line-item UUID is the access token on /pay. RLS bypass is by design.
  const supabase = createServiceClient();
  const { data, error } = await supabase
    .from("billing_line_items")
    .select("id")
    .eq("short_slug", slug)
    .maybeSingle<{ id: string }>();

  if (error) {
    console.warn(
      JSON.stringify({
        event: "payment.short_slug.error",
        slug_hash: slug.length, // never log the slug itself (treat as a token)
        ip_truncated: ipTruncated,
        err_message: error.message,
        at: new Date().toISOString(),
      }),
    );
    logShortSlugEvent({
      slug,
      ipTruncated,
      outcome: "error",
      durationMs: Date.now() - startedAt,
    });
    return htmlResponse(
      500,
      "Unexpected error",
      "We couldn't resolve this payment link. Please try again or contact your operator.",
    );
  }

  if (!data) {
    logShortSlugEvent({
      slug,
      ipTruncated,
      outcome: "not_found",
      durationMs: Date.now() - startedAt,
    });
    return htmlResponse(
      404,
      "Bill not found",
      "This bill is not available — please contact your operator.",
    );
  }

  // 3. Resolve to legacy /pay route via a RELATIVE 302 — preserves Host,
  //    no host-spoofing surface.
  const location = `/api/billing-line-items/${data.id}/pay`;

  logShortSlugEvent({
    slug,
    ipTruncated,
    outcome: "redirected",
    durationMs: Date.now() - startedAt,
    lineItemId: data.id,
  });

  return new NextResponse(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
    },
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Read client IP from headers. Mirrors `pay/route.ts:readClientIp` —
 * deliberately duplicated rather than extracted so the slug route stays
 * trivially auditable as a tiny self-contained handler.
 */
function readClientIp(request: NextRequest): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

/**
 * Truncate IPv4 to /24 and IPv6 to /48. Mirrors `pay/route.ts:truncateIp`.
 */
function truncateIp(ip: string): string {
  if (!ip || ip === "unknown") return "unknown";
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
    const parts = ip.split(".");
    return `${parts[0]}.${parts[1]}.${parts[2]}.0`;
  }
  if (ip.includes(":")) {
    const parts = ip.split(":");
    const head = parts.slice(0, 3).join(":");
    return `${head}::/48`;
  }
  return ip;
}

function htmlBody(title: string, message: string): string {
  // Minimal, dependency-free HTML — mirrors pay/route.ts. Title/message are
  // NEVER user-supplied; escaping omitted intentionally.
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

function logShortSlugEvent(args: {
  slug: string;
  ipTruncated: string;
  outcome: "redirected" | "not_found" | "bad_shape" | "error";
  durationMs: number;
  lineItemId?: string;
}): void {
  // Note: we do NOT log the slug itself — treat it as a bearer token. We
  // only log its length as a structural signal. The line_item_id on the
  // happy path is fine to log (it's already in stdout via /pay logs).
  const payload = {
    event: "payment.short_slug.received",
    slug_length: args.slug.length,
    line_item_id: args.lineItemId ?? null,
    ip_truncated: args.ipTruncated,
    outcome: args.outcome,
    duration_ms: args.durationMs,
    at: new Date().toISOString(),
  };
  const scrubbed = scrubSecretValues(payload, { extra: [args.slug] });
  console.info(JSON.stringify(scrubbed));
}
