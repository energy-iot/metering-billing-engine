/**
 * Middleware tests (UX5d / #190).
 *
 * Coverage (per AC8 + AC9 of #190):
 *   - Unauthenticated GET on /forgot-password is NOT redirected to /login.
 *   - Unauthenticated GET on /reset-password is NOT redirected to /login.
 *   - Public-paths check still allows /login and /accept-invite (UX5c).
 *   - Unauthenticated GET on a private path (/dashboard) IS redirected.
 *
 * Located in src/lib/__tests__ so it runs under the `lib` vitest
 * project (vitest.config.ts only globs src/lib, src/components, and
 * src/app).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock @supabase/ssr so getUser() resolves to a deterministic value.
const getUserMock = vi.fn();

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: {
      getUser: getUserMock,
    },
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  getUserMock.mockReset();
  // Provide minimal env for the middleware to construct a client.
  process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
});

async function loadMiddleware() {
  vi.resetModules();
  return (await import("../../middleware")).middleware;
}

function makeRequest(pathname: string) {
  return new NextRequest(`http://localhost${pathname}`);
}

describe("middleware PUBLIC_PATHS", () => {
  it("allows unauthenticated GET on /forgot-password (no redirect)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/forgot-password"));

    // Pass-through (NextResponse.next), not a redirect to /login.
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /reset-password (no redirect)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/reset-password"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /login (regression)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/login"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("allows unauthenticated GET on /accept-invite (regression — UX5c)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/accept-invite"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("redirects unauthenticated GET on a private path to /login", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/dashboard"));

    // NextResponse.redirect sets a 3xx and a Location header.
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toMatch(/\/login$/);
  });

  // #223: /p/<slug> is the consumer-facing payment-link indirection.
  // Customers arrive with no MBE session; the middleware MUST pass-through
  // (the route's service-role SELECT is the access-control gate).
  it("allows unauthenticated GET on /p/<slug> (consumer payment link — #223)", async () => {
    getUserMock.mockResolvedValue({ data: { user: null }, error: null });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/p/Kp9XrA"));

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("authenticated GET on /p/<slug> is also pass-through (no redirect to /)", async () => {
    getUserMock.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });
    const middleware = await loadMiddleware();

    const res = await middleware(makeRequest("/p/Kp9XrA"));

    // No redirect — neither to /login nor to / (the authenticated-on-/login
    // branch is the only place a logged-in user gets redirected to root).
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });
});
