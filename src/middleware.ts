import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// Paths that don't require an authenticated session. `/accept-invite`
// is reached unauthenticated by users clicking the invite-email link
// — verifyOtp on the page installs the session cookie (UX5c / #189).
// `/forgot-password` is the request side of the password-recovery flow;
// `/reset-password` is the consumption side reached by the recovery
// email link — verifyOtp on that page installs the session cookie
// (UX5d / #190).
// `/p/<slug>` is the consumer-facing payment-link indirection (#223) —
// customers click from WhatsApp with no MBE session; the slug is the
// access token (6-8 chars base62 entropy + DB lookup, with IP rate-limit
// applied downstream by the legacy /api/billing-line-items/<id>/pay route).
// Trailing slash is intentional — avoids prefix-matching any future top-
// level `/page` or `/profile` route.
//
// `/api/v1/` is the customerapp internal-API surface (#249 umbrella, Wave
// A-D). Per-org token auth via `resolveOrgFromToken` in
// `@/lib/internal-auth` is the authoritative auth boundary for these
// routes — customerapp sends an `x-api-key` header, not a cookie session,
// so `supabase.auth.getUser()` here would always return null and the
// middleware would 401 every request before the route handler can run.
// Each route handler calls `resolveOrgFromToken` first thing and rejects
// with structured 401/403 codes (`missing_header`, `invalid_format`,
// `not_found`, `revoked`, `customerapp_not_enabled`) that are deliberately
// distinct from this middleware's "Authentication required" string.
// Trailing slash is intentional (same reason as `/p/`).
// Discovered 2026-05-27 during Wave A-D activation smoke test.
const PUBLIC_PATHS = [
  "/login",
  "/accept-invite",
  "/forgot-password",
  "/reset-password",
  "/p/",
  "/api/v1/",
];

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request,
  });

  const cookieName = process.env.NEXT_PUBLIC_SUPABASE_COOKIE_NAME;

  const supabase = createServerClient(
    process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      ...(cookieName ? { cookieOptions: { name: cookieName } } : {}),
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isPublicPath = PUBLIC_PATHS.some((p) =>
    request.nextUrl.pathname.startsWith(p)
  );

  if (!user && !isPublicPath) {
    // API routes return 401 JSON instead of redirecting to login
    if (request.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 }
      );
    }
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    return NextResponse.redirect(url);
  }

  if (user && request.nextUrl.pathname.startsWith("/login")) {
    const url = request.nextUrl.clone();
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder assets
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
