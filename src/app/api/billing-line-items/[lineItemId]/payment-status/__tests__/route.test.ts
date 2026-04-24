/**
 * PATCH /api/billing-line-items/[lineItemId]/payment-status — unit tests (#124).
 *
 * Covers the 10-case matrix from the ticket ACs:
 *   (a) 200 unpaid → paid with notes
 *   (b) 200 paid → unpaid (audit fields cleared)
 *   (c) 200 failed → paid (operator override)
 *   (d) 400 paid → failed body Zod rejection → invalid_body
 *   (e) 400 paid → paid → no_op
 *   (f) 400 refunded → paid → invalid_transition
 *   (g) 403 cross-microgrid
 *   (h) 404 RLS-hidden line item
 *   (i) 400 invalid body (missing status, notes > 500 chars)
 *   (j) Log record has notes_present bool, NOT raw notes text
 *   (k) 401 session_expired when auth.getUser() returns null user on paid transition
 *
 * Auth pattern: auth.getUser() is resolved ONCE at route entry (after the
 * permission gate). The mock fires once per request — not twice — matching the
 * eager-resolve pattern introduced in #129 for the url route.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const ACTOR_USER_ID = "550e8400-e29b-41d4-a716-446655440099";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let canAccessMicrogridReturn = true;
vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

// Supabase mock — configurable per test.
let scopeResponse: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
let updateResponse: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

const mockFrom = vi.fn();
const mockGetUser = vi
  .fn()
  .mockResolvedValue({ data: { user: { id: ACTOR_USER_ID } } });

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: { getUser: mockGetUser },
  }),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeScopeRow(paymentStatus: string) {
  return {
    id: LINE_ITEM_ID,
    payment_status: paymentStatus,
    billing_period_id: "bp-1",
    billing_periods: {
      id: "bp-1",
      microgrid_id: MICROGRID_ID,
      start_date: "2026-03-01",
      end_date: "2026-03-31",
    },
    households: {
      display_name: "Alice Mukasa",
    },
  };
}

function makeUpdatedRow(paymentStatus: string, extras: Record<string, unknown> = {}) {
  return {
    id: LINE_ITEM_ID,
    billing_period_id: "bp-1",
    household_id: "hh-1",
    total_amount: 12500,
    usage_kwh: 45.5,
    payment_status: paymentStatus,
    ...extras,
  };
}

function makeReq(body: unknown): NextRequest {
  return new NextRequest(
    `http://localhost/api/billing-line-items/${LINE_ITEM_ID}/payment-status`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  canAccessMicrogridReturn = true;

  // Default: scope query succeeds with an unpaid item.
  scopeResponse = { data: makeScopeRow("unpaid"), error: null };
  updateResponse = {
    data: makeUpdatedRow("paid", {
      paid_at: "2026-04-23T12:00:00.000Z",
      paid_by_user_id: ACTOR_USER_ID,
      payment_notes: null,
    }),
    error: null,
  };

  // Wire mockFrom to handle both the scope SELECT and the UPDATE chain.
  mockFrom.mockImplementation(() => {
    return {
      // scope query: .select(...).eq(...).maybeSingle()
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
          single: vi.fn().mockResolvedValue(scopeResponse),
        }),
      }),
      // update chain: .update(...).eq(...).select().single()
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(updateResponse),
          }),
        }),
      }),
    };
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/billing-line-items/[lineItemId]/payment-status", () => {
  // ─── (a) 200 unpaid → paid with notes ─────────────────────────────────────
  it("(a) 200: unpaid→paid with notes — paid_at/paid_by_user_id/notes persisted", async () => {
    const NOTES = "Cash received 2026-04-23";
    const updatedRow = makeUpdatedRow("paid", {
      paid_at: "2026-04-23T12:00:00.000Z",
      paid_by_user_id: ACTOR_USER_ID,
      payment_notes: NOTES,
    });
    updateResponse = { data: updatedRow, error: null };
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(updateResponse),
          }),
        }),
      }),
    }));

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid", notes: NOTES }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("success");
    expect(body.line_item.payment_status).toBe("paid");
    expect(body.line_item.paid_at).toBeTruthy();
    expect(body.line_item.paid_by_user_id).toBe(ACTOR_USER_ID);
    expect(body.line_item.payment_notes).toBe(NOTES);
  });

  // ─── (b) 200 paid → unpaid (audit fields cleared) ─────────────────────────
  it("(b) 200: paid→unpaid — paid_at/paid_by_user_id/notes all NULL", async () => {
    scopeResponse = { data: makeScopeRow("paid"), error: null };
    const updatedRow = makeUpdatedRow("unpaid", {
      paid_at: null,
      paid_by_user_id: null,
      payment_notes: null,
    });
    updateResponse = { data: updatedRow, error: null };
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(updateResponse),
          }),
        }),
      }),
    }));

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "unpaid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("success");
    expect(body.line_item.payment_status).toBe("unpaid");
    expect(body.line_item.paid_at).toBeNull();
    expect(body.line_item.paid_by_user_id).toBeNull();
    expect(body.line_item.payment_notes).toBeNull();
  });

  // ─── (c) 200 failed → paid (operator override) ────────────────────────────
  it("(c) 200: failed→paid — operator override of failed IPN", async () => {
    scopeResponse = { data: makeScopeRow("failed"), error: null };
    const updatedRow = makeUpdatedRow("paid", {
      paid_at: "2026-04-23T12:00:00.000Z",
      paid_by_user_id: ACTOR_USER_ID,
      payment_notes: null,
    });
    updateResponse = { data: updatedRow, error: null };
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(updateResponse),
          }),
        }),
      }),
    }));

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("success");
    expect(body.line_item.payment_status).toBe("paid");
  });

  // ─── (d) 400 paid → failed body Zod rejection → invalid_body ──────────────
  it("(d) 400: body with status='failed' rejected at body layer → invalid_body", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "failed" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_body");
  });

  // ─── (e) 400 paid → paid → no_op ──────────────────────────────────────────
  it("(e) 400: paid→paid → reason: no_op", async () => {
    scopeResponse = { data: makeScopeRow("paid"), error: null };
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(updateResponse),
          }),
        }),
      }),
    }));

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("no_op");
  });

  // ─── (f) 400 refunded → paid → invalid_transition ─────────────────────────
  it("(f) 400: refunded→paid → reason: invalid_transition", async () => {
    scopeResponse = { data: makeScopeRow("refunded"), error: null };
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(updateResponse),
          }),
        }),
      }),
    }));

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_transition");
  });

  // ─── (g) 403 cross-microgrid ──────────────────────────────────────────────
  it("(g) 403: returns forbidden when user cannot access the microgrid", async () => {
    canAccessMicrogridReturn = false;

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("forbidden");
  });

  // ─── (h) 404 RLS-hidden line item ─────────────────────────────────────────
  it("(h) 404: returns not_found when line item is RLS-hidden", async () => {
    scopeResponse = { data: null, error: null };
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(updateResponse),
          }),
        }),
      }),
    }));

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("not_found");
  });

  // ─── (i) 400 invalid body ─────────────────────────────────────────────────
  it("(i) 400: missing status field → invalid_body", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ notes: "something" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_body");
  });

  it("(i) 400: notes > 500 chars → invalid_body", async () => {
    const { PATCH } = await import("../route");
    const longNotes = "x".repeat(501);
    const res = await PATCH(makeReq({ status: "paid", notes: longNotes }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_body");
  });

  it("(i) 400: status='refunded' (not allowed in body) → invalid_body", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "refunded" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_body");
  });

  // ─── (j) Log record has notes_present, NOT raw notes ─────────────────────
  it("(j) log record has notes_present: boolean, NOT raw notes text", async () => {
    const NOTES = "M-Pesa receipt #KJ3F456 — private PII reference";
    const updatedRow = makeUpdatedRow("paid", {
      paid_at: "2026-04-23T12:00:00.000Z",
      paid_by_user_id: ACTOR_USER_ID,
      payment_notes: NOTES,
    });
    updateResponse = { data: updatedRow, error: null };
    mockFrom.mockImplementation(() => ({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
        }),
      }),
      update: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnValue({
            single: vi.fn().mockResolvedValue(updateResponse),
          }),
        }),
      }),
    }));

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid", notes: NOTES }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);

    // Find the payment.manual_mark log line.
    const logCalls = infoSpy.mock.calls.map((args) => String(args[0]));
    const matching = logCalls.filter((s) => s.includes('"payment.manual_mark"'));
    expect(matching.length).toBeGreaterThanOrEqual(1);

    const logRecord = JSON.parse(matching[0]);

    // notes_present must be boolean true.
    expect(logRecord.notes_present).toBe(true);

    // Raw notes text must NOT appear in the log.
    const joined = matching.join("\n");
    expect(joined).not.toContain(NOTES);
    expect(joined).not.toContain("M-Pesa receipt");
    expect(joined).not.toContain("private PII reference");

    // Log record must include expected audit fields.
    expect(logRecord.event).toBe("payment.manual_mark");
    expect(logRecord.line_item_id).toBe(LINE_ITEM_ID);
    expect(logRecord.microgrid_id).toBe(MICROGRID_ID);
    expect(logRecord.from_status).toBe("unpaid");
    expect(logRecord.to_status).toBe("paid");

    infoSpy.mockRestore();
  });

  // ─── notes_present: false when no notes ───────────────────────────────────
  it("(j) log record has notes_present: false when no notes provided", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { PATCH } = await import("../route");
    await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    const logCalls = infoSpy.mock.calls.map((args) => String(args[0]));
    const matching = logCalls.filter((s) => s.includes('"payment.manual_mark"'));
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const logRecord = JSON.parse(matching[0]);
    expect(logRecord.notes_present).toBe(false);

    infoSpy.mockRestore();
  });

  // ─── (k) 401 session_expired when getUser() returns null user ─────────────
  //
  // auth.getUser() returning { data: { user: null } } is an edge case (degraded
  // session) that would otherwise write null to paid_by_user_id, triggering the
  // billing_line_items_payment_audit_fields_required CHECK constraint and
  // surfacing as an opaque 500 invariant_violation. The eager null-guard short-
  // circuits before the UPDATE and returns a user-actionable 401.
  it("(k) 401 session_expired when auth.getUser() returns null user on paid transition", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe("session_expired");
    expect(typeof body.error).toBe("string");
  });
});
