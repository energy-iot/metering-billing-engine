/**
 * PATCH /api/billing-line-items/[lineItemId]/payment-status — unit tests.
 *
 * Phase B (#157) updates: body whitelist widened to {unpaid|paid|failed|refunded};
 * 'failed' / 'refunded' gated to super_admin; all transitions go through the
 * authoritative `fn_apply_payment_event` RPC (audit row appended in the DB).
 *
 * Coverage:
 *   (a) 200 unpaid → paid with notes (note piped through RPC `_raw_payload`)
 *   (b) 200 paid → unpaid (audit fields + notes cleared atomically by RPC)
 *   (c) 200 failed → paid (super_admin override)
 *   (d) 400 invalid body (unknown status → invalid_body)
 *   (e) 400 paid → paid → no_op
 *   (f) 400 refunded → paid → invalid_transition
 *   (g) 403 cross-microgrid (forbidden)
 *   (h) 404 RLS-hidden line item
 *   (i) 400 invalid body (missing status, notes > 500 chars)
 *   (j) Log record has notes_present bool, NOT raw notes text
 *   (k) 401 session_expired when actor null on paid transition
 *   (l) 403 super_admin_required when org_manager attempts 'failed'
 *   (m) 200 paid → refunded (super_admin only)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const LINE_ITEM_ID = "550e8400-e29b-41d4-a716-446655440001";
const MICROGRID_ID = "550e8400-e29b-41d4-a716-446655440002";
const ACTOR_USER_ID = "550e8400-e29b-41d4-a716-446655440099";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let canAccessMicrogridReturn = true;
let isSuperAdminReturn = true;
vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
  currentUserIsSuperAdmin: async () => isSuperAdminReturn,
}));

// Supabase mock — configurable per test.
let scopeResponse: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};
let rpcResponse: { data: unknown; error: { message?: string; code?: string } | null } = {
  data: null,
  error: null,
};
let updateResponse: { data: unknown; error: unknown } = {
  data: null,
  error: null,
};

const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockGetUser = vi
  .fn()
  .mockResolvedValue({ data: { user: { id: ACTOR_USER_ID } } });

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    rpc: mockRpc,
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
    households: { display_name: "Alice Mukasa" },
  };
}

function makeUpdatedRow(
  paymentStatus: string,
  extras: Record<string, unknown> = {},
) {
  return {
    id: LINE_ITEM_ID,
    billing_period_id: "bp-1",
    household_id: "hh-1",
    total_amount: 12500,
    usage_kwh: 45.5,
    payment_status: paymentStatus,
    paid_at: null,
    paid_by_user_id: null,
    payment_notes: null,
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
  isSuperAdminReturn = true;

  scopeResponse = { data: makeScopeRow("unpaid"), error: null };
  rpcResponse = {
    data: makeUpdatedRow("paid", {
      paid_at: "2026-04-23T12:00:00.000Z",
      paid_by_user_id: ACTOR_USER_ID,
    }),
    error: null,
  };
  updateResponse = { data: null, error: null };

  mockFrom.mockImplementation(() => ({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({
        maybeSingle: vi.fn().mockResolvedValue(scopeResponse),
      }),
    }),
    update: vi.fn().mockReturnValue({
      eq: vi.fn().mockResolvedValue(updateResponse),
    }),
  }));
  mockRpc.mockImplementation(() =>
    Promise.resolve({ data: rpcResponse.data, error: rpcResponse.error }),
  );
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PATCH /api/billing-line-items/[lineItemId]/payment-status (Phase B)", () => {
  it("(a) 200: unpaid→paid with notes — RPC called with manual source + payment_notes payload", async () => {
    const NOTES = "Cash received 2026-04-23";
    rpcResponse = {
      data: makeUpdatedRow("paid", {
        paid_at: "2026-04-23T12:00:00.000Z",
        paid_by_user_id: ACTOR_USER_ID,
        payment_notes: NOTES, // RPC writes payment_notes atomically from _raw_payload
      }),
      error: null,
    };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid", notes: NOTES }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("success");
    expect(body.line_item.payment_status).toBe("paid");
    expect(body.line_item.payment_notes).toBe(NOTES);

    // RPC invoked correctly. The note is piped through `_raw_payload` so it
    // gets written inside the SECURITY DEFINER UPDATE — no second RLS-bound
    // UPDATE that could be silently denied.
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const [fn, args] = mockRpc.mock.calls[0];
    expect(fn).toBe("fn_apply_payment_event");
    expect(args._line_item_id).toBe(LINE_ITEM_ID);
    expect(args._to_status).toBe("paid");
    expect(args._source).toBe("manual");
    expect(args._actor_user_id).toBe(ACTOR_USER_ID);
    expect(args._raw_payload).toEqual({ payment_notes: NOTES });

    // No follow-up plain UPDATE on billing_line_items — the RPC is the only
    // write path for both payment_status and payment_notes.
    expect(mockFrom).toHaveBeenCalledTimes(1); // scope read only
    expect(mockFrom.mock.calls[0][0]).toBe("billing_line_items");
  });

  it("(b) 200: paid→unpaid sends explicit payment_notes:null in RPC payload", async () => {
    scopeResponse = { data: makeScopeRow("paid"), error: null };
    rpcResponse = {
      data: makeUpdatedRow("unpaid"),
      error: null,
    };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "unpaid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.line_item.payment_status).toBe("unpaid");

    // Clearing notes happens atomically inside the RPC: payload carries an
    // explicit payment_notes:null so the SQL function distinguishes "absent"
    // (leave column unchanged) from "explicit clear" (set to NULL).
    expect(mockRpc).toHaveBeenCalledTimes(1);
    const args = mockRpc.mock.calls[0][1];
    expect(args._raw_payload).toEqual({ payment_notes: null });

    // No follow-up plain UPDATE.
    expect(mockFrom).toHaveBeenCalledTimes(1); // scope read only
  });

  it("(c) 200: failed→paid super_admin override", async () => {
    scopeResponse = { data: makeScopeRow("failed"), error: null };
    rpcResponse = {
      data: makeUpdatedRow("paid", {
        paid_at: "2026-04-23T12:00:00.000Z",
        paid_by_user_id: ACTOR_USER_ID,
      }),
      error: null,
    };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
  });

  it("(d) 400: unknown status → invalid_body", async () => {
    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "weird" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_body");
  });

  it("(e) 400: paid→paid → reason: no_op", async () => {
    scopeResponse = { data: makeScopeRow("paid"), error: null };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("no_op");
    // RPC must NOT be called when pre-flight rejects.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("(f) 400: refunded→paid → invalid_transition", async () => {
    scopeResponse = { data: makeScopeRow("refunded"), error: null };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_transition");
  });

  it("(g) 403: cannot access microgrid → forbidden", async () => {
    canAccessMicrogridReturn = false;

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("forbidden");
  });

  it("(h) 404: RLS-hidden line item", async () => {
    scopeResponse = { data: null, error: null };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.reason).toBe("not_found");
  });

  it("(i) 400: missing status → invalid_body", async () => {
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

  it("(j) log record has notes_present: true and does NOT contain the raw notes", async () => {
    const NOTES = "M-Pesa receipt #KJ3F456 — private PII reference";
    rpcResponse = {
      data: makeUpdatedRow("paid", {
        paid_at: "2026-04-23T12:00:00.000Z",
        paid_by_user_id: ACTOR_USER_ID,
      }),
      error: null,
    };
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid", notes: NOTES }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);

    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    const matching = logs.filter((s) => s.includes('"payment.manual_mark"'));
    expect(matching.length).toBeGreaterThanOrEqual(1);
    const rec = JSON.parse(matching[0]);
    expect(rec.notes_present).toBe(true);
    expect(rec.event).toBe("payment.manual_mark");
    expect(rec.line_item_id).toBe(LINE_ITEM_ID);
    expect(rec.from_status).toBe("unpaid");
    expect(rec.to_status).toBe("paid");

    const joined = matching.join("\n");
    expect(joined).not.toContain(NOTES);
    expect(joined).not.toContain("M-Pesa receipt");

    infoSpy.mockRestore();
  });

  it("(j) log record has notes_present: false when no notes supplied", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const { PATCH } = await import("../route");
    await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    const logs = infoSpy.mock.calls.map((c) => String(c[0]));
    const matching = logs.filter((s) => s.includes('"payment.manual_mark"'));
    const rec = JSON.parse(matching[0]);
    expect(rec.notes_present).toBe(false);
    infoSpy.mockRestore();
  });

  it("(k) 401: session_expired when getUser returns null on paid transition", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.reason).toBe("session_expired");
  });

  it("(l) 403 super_admin_required when non-super_admin sends 'failed'", async () => {
    isSuperAdminReturn = false;
    scopeResponse = { data: makeScopeRow("link_generated"), error: null };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "failed" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("super_admin_required");
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("(m) 200 paid→refunded — super_admin allowed", async () => {
    scopeResponse = { data: makeScopeRow("paid"), error: null };
    rpcResponse = {
      data: makeUpdatedRow("refunded", {
        paid_at: "2026-04-23T12:00:00.000Z",
        paid_by_user_id: ACTOR_USER_ID,
      }),
      error: null,
    };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "refunded" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.line_item.payment_status).toBe("refunded");
    expect(mockRpc.mock.calls[0][1]._to_status).toBe("refunded");
  });

  it("RPC error: surfaces invalid_transition from DB as 400", async () => {
    rpcResponse = {
      data: null,
      error: { message: "invalid_transition: unpaid -> paid via manual" },
    };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.reason).toBe("invalid_transition");
  });

  it("RPC error: surfaces transition_conflict from DB as 409", async () => {
    rpcResponse = {
      data: null,
      error: { message: "transition_conflict: row state changed mid-flight" },
    };

    const { PATCH } = await import("../route");
    const res = await PATCH(makeReq({ status: "paid" }), {
      params: Promise.resolve({ lineItemId: LINE_ITEM_ID }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.reason).toBe("transition_conflict");
  });
});
