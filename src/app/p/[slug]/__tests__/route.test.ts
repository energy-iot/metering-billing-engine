/**
 * GET /p/[slug] — unit tests (#223).
 *
 * Coverage per AC4:
 *   - 302 happy path with RELATIVE Location `/api/billing-line-items/<id>/pay`
 *     and Cache-Control: no-store.
 *   - 400 on bad slug shape (no DB query attempted).
 *   - 404 on unknown slug (DB returned null).
 *   - 500 on service-role error.
 *   - Audit log uses `payment.short_slug.received` event shape with
 *     `outcome` field and never logs the slug body itself.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const GOOD_SLUG = "Kp9XrA";

// Configurable per-test SELECT outcome.
type SelectResult = {
  data: { id: string } | null;
  error: { message: string } | null;
};

let selectResult: SelectResult = { data: null, error: null };
const selectMock = vi.fn(() => Promise.resolve(selectResult));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: selectMock,
        }),
      }),
    }),
  }),
}));

function makeReq(slug: string, ip: string = "1.2.3.4"): NextRequest {
  return new NextRequest(`http://localhost/p/${slug}`, {
    method: "GET",
    headers: { "x-forwarded-for": ip },
  });
}

describe("GET /p/[slug]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    selectResult = { data: null, error: null };
  });

  it("(302) redirects with RELATIVE Location to /api/billing-line-items/<id>/pay", async () => {
    selectResult = { data: { id: LINE_ITEM_ID }, error: null };
    const { GET } = await import("../route");

    const res = await GET(makeReq(GOOD_SLUG), {
      params: Promise.resolve({ slug: GOOD_SLUG }),
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location");
    // RELATIVE — must NOT start with http(s):// or //.
    expect(location).toBe(`/api/billing-line-items/${LINE_ITEM_ID}/pay`);
    expect(location?.startsWith("http")).toBe(false);
    expect(location?.startsWith("//")).toBe(false);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("(302) accepts 8-char slug (upper bound of CHECK regex)", async () => {
    selectResult = { data: { id: LINE_ITEM_ID }, error: null };
    const { GET } = await import("../route");
    const slug8 = "AbCd1234";
    const res = await GET(makeReq(slug8), {
      params: Promise.resolve({ slug: slug8 }),
    });
    expect(res.status).toBe(302);
  });

  it("(400) rejects a 5-char slug (below CHECK lower bound)", async () => {
    const { GET } = await import("../route");
    const slug5 = "abcde";
    const res = await GET(makeReq(slug5), {
      params: Promise.resolve({ slug: slug5 }),
    });
    expect(res.status).toBe(400);
    // No DB call attempted on shape-rejection (cheap fail-fast).
    expect(selectMock).not.toHaveBeenCalled();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("(400) rejects a 9-char slug (above CHECK upper bound)", async () => {
    const { GET } = await import("../route");
    const slug9 = "abcdefghi";
    const res = await GET(makeReq(slug9), {
      params: Promise.resolve({ slug: slug9 }),
    });
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("(400) rejects non-base62 characters", async () => {
    const { GET } = await import("../route");
    const slugBad = "abc-12";
    const res = await GET(makeReq(slugBad), {
      params: Promise.resolve({ slug: slugBad }),
    });
    expect(res.status).toBe(400);
    expect(selectMock).not.toHaveBeenCalled();
  });

  it("(404) renders 'Bill not found' when slug is well-shaped but missing", async () => {
    selectResult = { data: null, error: null };
    const { GET } = await import("../route");

    const res = await GET(makeReq(GOOD_SLUG), {
      params: Promise.resolve({ slug: GOOD_SLUG }),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).toMatch(/not available/i);
  });

  it("(500) renders generic error HTML on service-role failure", async () => {
    selectResult = { data: null, error: { message: "kaboom" } };
    const { GET } = await import("../route");

    const res = await GET(makeReq(GOOD_SLUG), {
      params: Promise.resolve({ slug: GOOD_SLUG }),
    });

    expect(res.status).toBe(500);
    const body = await res.text();
    // Generic copy — no leaking of the underlying error message.
    expect(body).not.toContain("kaboom");
  });

  it("logs `payment.short_slug.received` with outcome=redirected on happy path", async () => {
    selectResult = { data: { id: LINE_ITEM_ID }, error: null };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { GET } = await import("../route");
    await GET(makeReq(GOOD_SLUG), {
      params: Promise.resolve({ slug: GOOD_SLUG }),
    });
    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    const matching = logs.filter((s) =>
      s.includes("payment.short_slug.received"),
    );
    expect(matching.length).toBeGreaterThanOrEqual(1);
    expect(matching[0]).toContain('"outcome":"redirected"');
    // The slug ITSELF must not appear in the log (it's a bearer token).
    expect(matching[0]).not.toContain(GOOD_SLUG);
    infoSpy.mockRestore();
  });

  it("logs outcome=not_found on missing slug", async () => {
    selectResult = { data: null, error: null };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { GET } = await import("../route");
    await GET(makeReq(GOOD_SLUG), {
      params: Promise.resolve({ slug: GOOD_SLUG }),
    });
    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    const matching = logs.filter((s) =>
      s.includes("payment.short_slug.received"),
    );
    expect(matching.some((s) => s.includes('"outcome":"not_found"'))).toBe(
      true,
    );
    infoSpy.mockRestore();
  });

  it("logs outcome=bad_shape on a malformed slug (no DB query)", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { GET } = await import("../route");
    await GET(makeReq("abc-12"), {
      params: Promise.resolve({ slug: "abc-12" }),
    });
    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    const matching = logs.filter((s) =>
      s.includes("payment.short_slug.received"),
    );
    expect(matching.some((s) => s.includes('"outcome":"bad_shape"'))).toBe(
      true,
    );
    infoSpy.mockRestore();
  });

  it("truncates IPv4 to /24 in audit log", async () => {
    selectResult = { data: { id: LINE_ITEM_ID }, error: null };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { GET } = await import("../route");
    await GET(makeReq(GOOD_SLUG, "203.0.113.42"), {
      params: Promise.resolve({ slug: GOOD_SLUG }),
    });
    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    const matching = logs
      .filter((s) => s.includes("payment.short_slug.received"))
      .join("\n");
    expect(matching).toContain("203.0.113.0");
    expect(matching).not.toContain("203.0.113.42");
    infoSpy.mockRestore();
  });
});
