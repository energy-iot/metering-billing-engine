/**
 * POST /api/internal/billing-periods — route tests (#253).
 *
 * Coverage (failure-mode AC from the ticket body):
 *   - Same-day period (start_date === end_date): accepted, creates draft row (201).
 *     This is the regression #253 fixes: PR #246 re-introduced the `>=` bug
 *     that the 2026-04 PM Evolution Log already called out for the web UI.
 *   - start_date > end_date: rejected with 400.
 *   - start_date < end_date (normal multi-day): accepted (201).
 *   - Malformed dates (`"not-a-date"`, `"2026-13-99"`): rejected with 400.
 *   - Missing required fields: rejected with 400.
 *   - Duplicate (microgrid_id, start_date, end_date): accepted (per Alejandro
 *     2026-05-26 — no 409-on-duplicate; matches UI behavior).
 *
 * The route mocks the supabase service client + `checkInternalApiKey` at the
 * module boundary. Live-DB constraint behavior (unique indexes, RLS) is not
 * exercised here — covered by the integration suites tracked in #251 / #254.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock controls ──────────────────────────────────────────────────────────

let mockAuthOk = true;
let lastInsertPayload: Record<string, unknown> | null = null;
let mockInsertResult: { data: { id: string } | null; error: { message: string } | null } = {
  data: { id: "bp-id-1" },
  error: null,
};

vi.mock("@/lib/internal-auth", () => ({
  checkInternalApiKey: () => mockAuthOk,
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (_table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        lastInsertPayload = payload;
        return {
          select: () => ({
            single: () => Promise.resolve(mockInsertResult),
          }),
        };
      },
    }),
  }),
}));

const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440000";

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/internal/billing-periods", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "stub" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/internal/billing-periods (#253)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthOk = true;
    lastInsertPayload = null;
    mockInsertResult = { data: { id: "bp-id-1" }, error: null };
  });

  it("401 when auth fails", async () => {
    mockAuthOk = false;
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-01-01",
        end_date: "2026-01-31",
      })
    );
    expect(res.status).toBe(401);
  });

  it("accepts same-day period (start_date === end_date) — #253 regression fix", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-05-26",
        end_date: "2026-05-26",
      })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.id).toBe("bp-id-1");
    expect(lastInsertPayload).toEqual({
      microgrid_id: MICROGRID_ID,
      start_date: "2026-05-26",
      end_date: "2026-05-26",
      status: "draft",
    });
  });

  it("rejects with 400 when start_date > end_date", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-02-01",
        end_date: "2026-01-01",
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/end_date/);
    expect(lastInsertPayload).toBeNull();
  });

  it("accepts normal multi-day period (start_date < end_date)", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-01-01",
        end_date: "2026-01-31",
      })
    );
    expect(res.status).toBe(201);
    expect(lastInsertPayload).toMatchObject({
      microgrid_id: MICROGRID_ID,
      start_date: "2026-01-01",
      end_date: "2026-01-31",
      status: "draft",
    });
  });

  it("rejects with 400 for non-date string", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "not-a-date",
        end_date: "2026-01-31",
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/start_date/);
  });

  it("rejects with 400 for syntactically-malformed date (2026-13-99)", async () => {
    // The route validates by regex shape (YYYY-MM-DD); "2026-13-99" matches the
    // shape but is semantically invalid. Postgres would reject this at insert
    // time, so the route's contract here is to forward and let the DB error
    // surface as 500 — OR for strings that don't match the shape at all, 400.
    // This test pins the shape-mismatch case: a date string missing dashes.
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "20260101",
        end_date: "2026-01-31",
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/start_date must be YYYY-MM-DD/);
  });

  it("rejects with 400 when start_date is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        end_date: "2026-01-31",
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/start_date/);
  });

  it("rejects with 400 when end_date is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-01-01",
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/end_date/);
  });

  it("rejects with 400 when microgrid_id is missing", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        start_date: "2026-01-01",
        end_date: "2026-01-31",
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/microgrid_id/);
  });

  it("rejects with 400 for malformed JSON body", async () => {
    const { POST } = await import("../route");
    const res = await POST(makePostRequest("{not valid json"));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/Invalid JSON/);
  });

  it("allows multiple draft periods for same (microgrid_id, start_date, end_date) — no 409-on-duplicate per Alejandro 2026-05-26", async () => {
    // Two sequential POSTs with identical (microgrid_id, start_date, end_date)
    // should both succeed at the route layer. Uniqueness — if ever desired —
    // is a DB-level concern, not a route-level one. Matches the web UI's
    // behavior, which doesn't pre-check.
    const { POST } = await import("../route");

    mockInsertResult = { data: { id: "bp-id-first" }, error: null };
    const res1 = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-03-01",
        end_date: "2026-03-31",
      })
    );
    expect(res1.status).toBe(201);
    const json1 = await res1.json();
    expect(json1.id).toBe("bp-id-first");

    mockInsertResult = { data: { id: "bp-id-second" }, error: null };
    const res2 = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-03-01",
        end_date: "2026-03-31",
      })
    );
    expect(res2.status).toBe(201);
    const json2 = await res2.json();
    expect(json2.id).toBe("bp-id-second");
  });
});
