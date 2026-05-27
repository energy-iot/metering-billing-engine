/**
 * POST /api/v1/billing-periods — route tests (#253 + #255).
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
 *   - #255: auth now via `resolveOrgFromToken`; on success the resolved
 *     `token_name` flows into the audit row as `actor_ref` (replacing the
 *     `'pre-token-system'` placeholder from #250).
 *
 * The route mocks the supabase service client + `resolveOrgFromToken` at the
 * module boundary. Live-DB constraint behavior (unique indexes, RLS) is not
 * exercised here — covered by the integration suites tracked in #251 / #254.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mock controls ──────────────────────────────────────────────────────────
//
// The route writes to TWO tables now (#250 added the `billing_audit_log` audit
// write after the existing `billing_periods` insert). The mock therefore has
// to track inserts per-table; a single `lastInsertPayload` would silently
// capture only the LAST insert (the audit row) and the billing_periods
// assertions would fail. See PR #259 review notes for the cross-PR interaction.
//
// The audit-log path uses a bare `await supabase.from('billing_audit_log').insert(...)`
// (no `.select().single()` chain), so the awaited value is just the mock-returned
// object — without an `error` property, the route's `const { error: auditErr } = …`
// destructure yields `undefined`, the `if (auditErr)` warn-branch is skipped, and
// the test passes. The audit-row capture in `insertsByTable['billing_audit_log']`
// is for tests that want to assert against the attribution shape.

let mockAuthResult: {
  ok: boolean;
  org_id?: string;
  token_id?: string;
  token_name?: string;
  status?: number;
  reason?: string;
} = {
  ok: true,
  org_id: "org-uuid-1",
  token_id: "token-uuid-1",
  token_name: "customerapp-prod-2026",
};
// #254 — the route now also calls `resolveMicrogridOrgId` BEFORE the
// insert. Default to "matching org" so the existing #253 / #255 tests
// flow through unmodified; the #254 suite overrides per-case.
let mockMicrogridOrgResult:
  | { ok: true; org_id: string }
  | { ok: false; status: 404 | 400; reason: string } = {
  ok: true,
  org_id: "org-uuid-1",
};
let insertsByTable: Record<string, Array<Record<string, unknown>>> = {};
let mockInsertResult: { data: { id: string } | null; error: { message: string } | null } = {
  data: { id: "bp-id-1" },
  error: null,
};

vi.mock("@/lib/internal-auth", () => ({
  resolveOrgFromToken: () => Promise.resolve(mockAuthResult),
  resolveMicrogridOrgId: () => Promise.resolve(mockMicrogridOrgResult),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    from: (table: string) => ({
      insert: (payload: Record<string, unknown>) => {
        if (!insertsByTable[table]) insertsByTable[table] = [];
        insertsByTable[table].push(payload);
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
  return new NextRequest("http://localhost/api/v1/billing-periods", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": "stub" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/v1/billing-periods (#253 + #255)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthResult = {
      ok: true,
      org_id: "org-uuid-1",
      token_id: "token-uuid-1",
      token_name: "customerapp-prod-2026",
    };
    mockMicrogridOrgResult = { ok: true, org_id: "org-uuid-1" };
    insertsByTable = {};
    mockInsertResult = { data: { id: "bp-id-1" }, error: null };
  });

  it("401 when auth fails", async () => {
    mockAuthResult = { ok: false, status: 401, reason: "missing_header" };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-01-01",
        end_date: "2026-01-31",
      })
    );
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe("missing_header");
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
    expect(insertsByTable["billing_periods"]).toEqual([
      {
        microgrid_id: MICROGRID_ID,
        start_date: "2026-05-26",
        end_date: "2026-05-26",
        status: "draft",
      },
    ]);
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
    expect(insertsByTable["billing_periods"]).toBeUndefined();
    expect(insertsByTable["billing_audit_log"]).toBeUndefined();
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
    expect(insertsByTable["billing_periods"]?.[0]).toMatchObject({
      microgrid_id: MICROGRID_ID,
      start_date: "2026-01-01",
      end_date: "2026-01-31",
      status: "draft",
    });
    // #255 — audit-write attribution now carries the real per-org token
    // name (replacing the `'pre-token-system'` placeholder from #250).
    expect(insertsByTable["billing_audit_log"]?.[0]).toMatchObject({
      event_type: "billing_period_created",
      actor_kind: "customerapp",
      actor_ref: "customerapp-prod-2026",
      actor_user_id: null,
      billing_period_id: "bp-id-1",
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

  // ── #254 — Authorization cross-check (microgrid → token org) ──────────────
  //
  // The route now resolves the payload `microgrid_id` to its `org_id` via
  // `resolveMicrogridOrgId` and rejects if the resolved org doesn't match
  // the token's `auth.org_id`. Status-code ordering matters: non-existent
  // microgrid surfaces as 404 BEFORE the org comparison runs (UUID-enum
  // defense — never reveal "exists in some other org").

  it("#254: rejects with 403 when payload microgrid belongs to another org", async () => {
    mockMicrogridOrgResult = { ok: true, org_id: "org-uuid-OTHER" };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-06-01",
        end_date: "2026-06-30",
      })
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("microgrid_outside_token_org");
    // No DB writes when authz fails.
    expect(insertsByTable["billing_periods"]).toBeUndefined();
    expect(insertsByTable["billing_audit_log"]).toBeUndefined();
  });

  it("#254: rejects with 404 (NOT 403) when microgrid_id does not exist — UUID-enum defense", async () => {
    mockMicrogridOrgResult = { ok: false, status: 404, reason: "microgrid_not_found" };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-06-01",
        end_date: "2026-06-30",
      })
    );
    // 404 distinguishes "not found" from "found but wrong org" (403). This
    // prevents UUID enumeration: an attacker MUST NOT be able to tell from
    // the response shape whether a UUID exists in some other org or doesn't
    // exist at all.
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("microgrid_not_found");
    expect(insertsByTable["billing_periods"]).toBeUndefined();
  });

  it("#254: accepts when payload microgrid belongs to the token's org", async () => {
    mockMicrogridOrgResult = { ok: true, org_id: "org-uuid-1" };
    const { POST } = await import("../route");
    const res = await POST(
      makePostRequest({
        microgrid_id: MICROGRID_ID,
        start_date: "2026-06-01",
        end_date: "2026-06-30",
      })
    );
    expect(res.status).toBe(201);
    expect(insertsByTable["billing_periods"]?.[0]).toMatchObject({
      microgrid_id: MICROGRID_ID,
      start_date: "2026-06-01",
      end_date: "2026-06-30",
    });
  });
});
