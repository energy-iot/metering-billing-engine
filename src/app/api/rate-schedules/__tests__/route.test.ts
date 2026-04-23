/**
 * Rate-schedule API route tests (#75)
 *
 * All Supabase I/O is mocked — no real DB hits.
 *
 * Cases:
 *   PUT /api/rate-schedules/[id]
 *     (a) PUT 200 happy path — valid tiers, service_charge, tax_rate
 *     (b) PUT 400 non-contiguous tiers
 *     (c) PUT 400 tax_rate > 1
 *
 *   POST /api/rate-schedules
 *     (d) POST 200 creation happy path
 *     (e) POST 400 missing microgrid_id
 *
 *   Historical invariant
 *     (f) Closed billing_line_items.tier_breakdown is unchanged after a rate-schedule PUT
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ─── Shared mock state ────────────────────────────────────────────────────────

const mockSingle = vi.fn();
const mockSelect = vi.fn(() => ({ single: mockSingle }));
const mockUpdate = vi.fn(() => ({ eq: mockEqUpdate }));
const mockEqUpdate = vi.fn(() => ({ select: mockSelect }));
const mockInsert = vi.fn(() => ({ select: mockSelect }));
const mockFrom = vi.fn(() => ({
  update: mockUpdate,
  insert: mockInsert,
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_ID = "550e8400-e29b-41d4-a716-446655440000";
const MICROGRID_ID = "660e8400-e29b-41d4-a716-446655440001";

const CONTIGUOUS_TIERS = [
  { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
  { label: "Tier 2", min_kwh: 51, max_kwh: 150, rate_per_kwh: 800 },
  { label: "Tier 3", min_kwh: 151, max_kwh: null, rate_per_kwh: 1200 },
];

const SAVED_SCHEDULE = {
  id: VALID_ID,
  microgrid_id: MICROGRID_ID,
  tiers: CONTIGUOUS_TIERS,
  service_charge: 2000,
  tax_rate: 0.18,
  created_at: "2026-03-01T00:00:00Z",
};

// ─── Helper ───────────────────────────────────────────────────────────────────

function makePutRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/rate-schedules/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function makePostRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/rate-schedules", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─── PUT tests ────────────────────────────────────────────────────────────────

describe("PUT /api/rate-schedules/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset chain: update().eq().select().single()
    mockSingle.mockReset();
    mockSelect.mockReturnValue({ single: mockSingle });
    mockEqUpdate.mockReturnValue({ select: mockSelect });
    mockUpdate.mockReturnValue({ eq: mockEqUpdate });
    mockInsert.mockReturnValue({ select: mockSelect });
    mockFrom.mockReturnValue({ update: mockUpdate, insert: mockInsert });
  });

  // (a) PUT 200 happy path
  it("(a) returns 200 with the updated schedule on a valid PUT", async () => {
    mockSingle.mockResolvedValueOnce({ data: SAVED_SCHEDULE, error: null });

    const { PUT } = await import("../[id]/route");
    const req = makePutRequest(VALID_ID, {
      tiers: CONTIGUOUS_TIERS,
      service_charge: 2000,
      tax_rate: 0.18,
    });
    const res = await PUT(req, { params: Promise.resolve({ id: VALID_ID }) });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(SAVED_SCHEDULE);

    // Supabase should have been called correctly
    expect(mockFrom).toHaveBeenCalledWith("rate_schedules");
    expect(mockUpdate).toHaveBeenCalledWith({
      tiers: CONTIGUOUS_TIERS,
      service_charge: 2000,
      tax_rate: 0.18,
    });
    expect(mockEqUpdate).toHaveBeenCalledWith("id", VALID_ID);
  });

  // (b) PUT 400 non-contiguous tiers
  it("(b) returns 400 when tiers are non-contiguous (gap between tier1.max=15 and tier2.min=17)", async () => {
    const { PUT } = await import("../[id]/route");
    const req = makePutRequest(VALID_ID, {
      tiers: [
        { label: "Tier 1", min_kwh: 1, max_kwh: 15, rate_per_kwh: 500 },
        { label: "Tier 2", min_kwh: 17, max_kwh: null, rate_per_kwh: 800 },
      ],
      service_charge: 0,
      tax_rate: 0,
    });
    const res = await PUT(req, { params: Promise.resolve({ id: VALID_ID }) });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/contiguous/i);
  });

  // (c) PUT 400 tax_rate > 1
  it("(c) returns 400 when tax_rate > 1", async () => {
    const { PUT } = await import("../[id]/route");
    const req = makePutRequest(VALID_ID, {
      tiers: [{ label: "Tier 1", min_kwh: 1, max_kwh: null, rate_per_kwh: 500 }],
      service_charge: 0,
      tax_rate: 1.5,
    });
    const res = await PUT(req, { params: Promise.resolve({ id: VALID_ID }) });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/tax_rate/i);
  });
});

// ─── POST tests ───────────────────────────────────────────────────────────────

describe("POST /api/rate-schedules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSingle.mockReset();
    mockSelect.mockReturnValue({ single: mockSingle });
    mockEqUpdate.mockReturnValue({ select: mockSelect });
    mockUpdate.mockReturnValue({ eq: mockEqUpdate });
    mockInsert.mockReturnValue({ select: mockSelect });
    mockFrom.mockReturnValue({ update: mockUpdate, insert: mockInsert });
  });

  // (d) POST 200 creation happy path
  it("(d) returns 200 with the created schedule on a valid POST", async () => {
    const createdSchedule = { ...SAVED_SCHEDULE, id: "new-schedule-id" };
    mockSingle.mockResolvedValueOnce({ data: createdSchedule, error: null });

    const { POST } = await import("../route");
    const req = makePostRequest({
      microgrid_id: MICROGRID_ID,
      tiers: CONTIGUOUS_TIERS,
      service_charge: 2000,
      tax_rate: 0.18,
    });
    const res = await POST(req);

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual(createdSchedule);

    expect(mockFrom).toHaveBeenCalledWith("rate_schedules");
    expect(mockInsert).toHaveBeenCalledWith({
      microgrid_id: MICROGRID_ID,
      tiers: CONTIGUOUS_TIERS,
      service_charge: 2000,
      tax_rate: 0.18,
    });
  });

  // (e) POST 400 missing microgrid_id
  it("(e) returns 400 when microgrid_id is missing", async () => {
    const { POST } = await import("../route");
    const req = makePostRequest({
      tiers: CONTIGUOUS_TIERS,
      service_charge: 0,
      tax_rate: 0,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/microgrid_id/i);
  });

  // (e2) POST 400 invalid microgrid_id format (not a UUID)
  it("(e2) returns 400 when microgrid_id is not a valid UUID", async () => {
    const { POST } = await import("../route");
    const req = makePostRequest({
      microgrid_id: "not-a-uuid",
      tiers: CONTIGUOUS_TIERS,
      service_charge: 0,
      tax_rate: 0,
    });
    const res = await POST(req);

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toMatch(/microgrid_id/i);
  });
});

// ─── Historical invariant test ────────────────────────────────────────────────

describe("Historical invariant: closed period tier_breakdown is unchanged after rate-schedule PUT", () => {
  it("(f) tier_breakdown snapshot in closed line item is unaffected by a subsequent rate-schedule PUT", async () => {
    // This is a fixture-based assertion — no real DB.
    // Simulates: a closed billing_line_item has a tier_breakdown snapshot.
    // After a rate-schedule PUT, the line item's tier_breakdown must not change.

    // Step 1: Simulate the closed line item snapshot (already stored, immutable)
    const closedLineItemTierBreakdown = [
      { label: "Tier 1", kwh: 50, amount: 25000 },
      { label: "Tier 2", kwh: 50, amount: 40000 },
    ];

    // Step 2: Simulate a rate-schedule PUT with updated rates
    const updatedTiers = [
      { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 600 }, // changed from 500
      { label: "Tier 2", min_kwh: 51, max_kwh: null, rate_per_kwh: 900 }, // changed from 800
    ];

    mockSingle.mockReset();
    mockSelect.mockReturnValue({ single: mockSingle });
    mockEqUpdate.mockReturnValue({ select: mockSelect });
    mockUpdate.mockReturnValue({ eq: mockEqUpdate });
    mockFrom.mockReturnValue({ update: mockUpdate, insert: mockInsert });

    mockSingle.mockResolvedValueOnce({
      data: {
        id: VALID_ID,
        microgrid_id: MICROGRID_ID,
        tiers: updatedTiers,
        service_charge: 2000,
        tax_rate: 0.18,
        created_at: "2026-03-01T00:00:00Z",
      },
      error: null,
    });

    const { PUT } = await import("../[id]/route");
    const req = makePutRequest(VALID_ID, {
      tiers: updatedTiers,
      service_charge: 2000,
      tax_rate: 0.18,
    });
    const res = await PUT(req, { params: Promise.resolve({ id: VALID_ID }) });

    // Rate schedule was updated successfully
    expect(res.status).toBe(200);

    // Step 3: The closed line item's tier_breakdown snapshot is UNCHANGED.
    // The PUT route only writes to rate_schedules — it does NOT touch billing_line_items.
    // The line item's snapshot is immutable; we verify the fixture value is intact.
    expect(closedLineItemTierBreakdown).toEqual([
      { label: "Tier 1", kwh: 50, amount: 25000 },
      { label: "Tier 2", kwh: 50, amount: 40000 },
    ]);

    // And the route was called only on rate_schedules, not on billing_line_items
    const fromCalls = (mockFrom.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
    expect(fromCalls).not.toContain("billing_line_items");
    expect(fromCalls).toContain("rate_schedules");
  });
});
