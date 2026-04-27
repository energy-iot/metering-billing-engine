/**
 * resolveOrigin — derive the user-facing `${proto}://${host}` origin
 * for an incoming request (UX5c / #189).
 *
 * Used to build per-call `redirectTo` URLs for invite / resend-invite
 * flows. The architectural decision (see ticket #189 AC5) is to keep
 * `redirectTo` per-call rather than introducing `NEXT_PUBLIC_SITE_URL`
 * — preview deploys + local dev work identically with no additional
 * environment configuration.
 *
 * Strategy:
 *   1. Read `x-forwarded-proto` + `x-forwarded-host` (Vercel + most
 *      reverse proxies set these).
 *   2. Fall back to `request.nextUrl.origin` for local dev (Next dev
 *      server doesn't set forwarded headers).
 *
 * Returns a string with no trailing slash; callers append paths.
 *
 * **Trust boundary:** this helper trusts `x-forwarded-*` because
 * Vercel's edge proxies overwrite (not append to) any client-supplied
 * forwarded headers, so the values are guaranteed proxy-controlled in
 * our deployment topology. Do NOT lift this helper into a topology
 * where the proxy passes through client-supplied forwarded headers
 * (raw nginx without `proxy_set_header X-Forwarded-* ...`,
 * direct-to-Node, etc.) — that would expose a redirect-injection
 * vector via spoofed `Host` / `X-Forwarded-Host`.
 */
import type { NextRequest } from "next/server";

export function resolveOrigin(request: NextRequest): string {
  const proto = request.headers.get("x-forwarded-proto");
  const host = request.headers.get("x-forwarded-host");
  if (proto && host) {
    return `${proto}://${host}`;
  }
  return request.nextUrl.origin;
}
