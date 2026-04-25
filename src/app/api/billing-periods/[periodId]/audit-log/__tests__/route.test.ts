/**
 * GET /api/billing-periods/[periodId]/audit-log — route tests (#173 BC1).
 *
 * Coverage:
 *   - 400 invalid UUID.
 *   - 401 no auth user.
 *   - 404 period not found / RLS-hidden.
 *   - 200 happy: returns merged entries from billing_audit_log + payment_events.
 *   - actorDisplayName derived from first_name + last_name (NOT a
 *     non-existent display_name column); falls back to email.
 *   - actorDisplayName is null when the actor is a super_admin hidden by
 *     user_can_see_user_profile (the user_directory `IN` query simply
 *     returns no row for that actor_user_id).
 *   - payment_events row with source='ipn' maps to eventType =
 *     'payment_status_changed' (NOT a non-existent enum entry).
 *   - payment_events row with source='generate_link' maps to
 *     'payment_link_generated'.
 *   - LIMIT 500 enforced on each side query.
 *   - Result IDs are prefixed (`audit:<uuid>` / `payment_event:<uuid>`).
 *
 * The full RLS gate is exercised in the live-DB suite at
 * src/lib/supabase/__tests__/billing_audit_log.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

let mockUser: { id: string } | null = {
  id: "11111111-1111-4111-8111-111111111111",
};

let mockPeriodResult: { data: { id: string } | null; error: unknown } = {
  data: { id: "660e8400-e29b-41d4-a716-446655441000" },
  error: null,
};

type AuditRow = Record<string, unknown>;
type PERow = Record<string, unknown>;
type LineItemHHRow = { id: string; households: { display_name: string } | null };
type DirectoryRow = {
  user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

let mockAuditRows: AuditRow[] = [];
let mockPeRows: PERow[] = [];
let mockLineItemHHRows: LineItemHHRow[] = [];
let mockDirectoryRows: DirectoryRow[] = [];

let auditLimit: number | null = null;
let peLimit: number | null = null;

function buildSupabaseStub() {
  return {
    auth: {
      getUser: async () => ({ data: { user: mockUser }, error: null }),
    },
    from: (table: string) => {
      if (table === "billing_periods") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => mockPeriodResult,
            }),
          }),
        };
      }
      if (table === "billing_audit_log") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: (n: number) => {
                  auditLimit = n;
                  return Promise.resolve({ data: mockAuditRows, error: null });
                },
              }),
            }),
          }),
        };
      }
      if (table === "payment_events") {
        return {
          select: () => ({
            eq: () => ({
              order: () => ({
                limit: (n: number) => {
                  peLimit = n;
                  return Promise.resolve({ data: mockPeRows, error: null });
                },
              }),
            }),
          }),
        };
      }
      if (table === "billing_line_items") {
        return {
          select: () => ({
            in: async () => ({ data: mockLineItemHHRows, error: null }),
          }),
        };
      }
      if (table === "user_directory") {
        return {
          select: () => ({
            in: async () => ({ data: mockDirectoryRows, error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => buildSupabaseStub(),
}));

const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";

function makeGetRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/billing-periods/${PERIOD_ID}/audit-log`,
    { method: "GET" }
  );
}

describe("GET /api/billing-periods/[periodId]/audit-log (#173 BC1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUser = { id: "11111111-1111-4111-8111-111111111111" };
    mockPeriodResult = {
      data: { id: PERIOD_ID },
      error: null,
    };
    mockAuditRows = [];
    mockPeRows = [];
    mockLineItemHHRows = [];
    mockDirectoryRows = [];
    auditLimit = null;
    peLimit = null;
  });

  it("400 when periodId is not a UUID", async () => {
    const { GET } = await import("../route");
    const res = await GET(
      new NextRequest("http://localhost/api/billing-periods/bad/audit-log"),
      { params: Promise.resolve({ periodId: "bad" }) }
    );
    expect(res.status).toBe(400);
  });

  it("401 when no auth user", async () => {
    mockUser = null;
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(401);
  });

  it("404 when period is not found / RLS-hidden", async () => {
    mockPeriodResult = { data: null, error: null };
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("LIMIT 500 enforced on both side queries", async () => {
    const { GET } = await import("../route");
    await GET(makeGetRequest(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(auditLimit).toBe(500);
    expect(peLimit).toBe(500);
  });

  it("merges audit rows + payment_events rows by createdAt DESC", async () => {
    mockAuditRows = [
      {
        id: "aaaaaaaa-1111-4111-8111-111111111111",
        billing_period_id: PERIOD_ID,
        billing_line_item_id: "bbbbbbbb-1111-4111-8111-111111111111",
        event_type: "line_item_regenerated",
        actor_user_id: "11111111-1111-4111-8111-111111111111",
        created_at: "2026-04-25T12:00:00Z",
        details: { household_name: "HH-A", new_total_amount: 5000 },
      },
    ];
    mockPeRows = [
      {
        id: "cccccccc-1111-4111-8111-111111111111",
        line_item_id: "bbbbbbbb-1111-4111-8111-111111111111",
        from_status: "unpaid",
        to_status: "paid",
        source: "manual",
        actor_user_id: "11111111-1111-4111-8111-111111111111",
        raw_payload: null,
        at: "2026-04-25T13:00:00Z",
        billing_line_items: {
          billing_period_id: PERIOD_ID,
          payment_notes: "M-Pesa #123",
          households: { display_name: "HH-A" },
        },
      },
    ];
    mockLineItemHHRows = [
      {
        id: "bbbbbbbb-1111-4111-8111-111111111111",
        households: { display_name: "HH-A" },
      },
    ];
    mockDirectoryRows = [
      {
        user_id: "11111111-1111-4111-8111-111111111111",
        email: "alice@example.test",
        first_name: "Alice",
        last_name: "Doe",
      },
    ];
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries).toHaveLength(2);
    // newest (the payment_event at 13:00) first
    expect(json.entries[0].id).toBe(
      "payment_event:cccccccc-1111-4111-8111-111111111111"
    );
    expect(json.entries[0].eventType).toBe("payment_status_changed");
    expect(json.entries[0].actorDisplayName).toBe("Alice Doe");
    expect(json.entries[0].details).toMatchObject({
      from: "unpaid",
      to: "paid",
      source: "manual",
      notes: "M-Pesa #123",
    });
    expect(json.entries[1].id).toBe(
      "audit:aaaaaaaa-1111-4111-8111-111111111111"
    );
    expect(json.entries[1].eventType).toBe("line_item_regenerated");
    expect(json.entries[1].householdName).toBe("HH-A");
  });

  it("payment_events source='generate_link' maps to 'payment_link_generated'", async () => {
    mockPeRows = [
      {
        id: "cccccccc-2222-4111-8111-111111111111",
        line_item_id: "bbbbbbbb-1111-4111-8111-111111111111",
        from_status: "unpaid",
        to_status: "link_generated",
        source: "generate_link",
        actor_user_id: null,
        raw_payload: { pesapal_order_id: "INV-1" },
        at: "2026-04-25T11:00:00Z",
        billing_line_items: {
          billing_period_id: PERIOD_ID,
          payment_notes: null,
          households: { display_name: "HH-A" },
        },
      },
    ];
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.entries[0].eventType).toBe("payment_link_generated");
  });

  it("actorDisplayName falls back to email when first_name+last_name both null", async () => {
    mockAuditRows = [
      {
        id: "aaaaaaaa-3333-4111-8111-111111111111",
        billing_period_id: PERIOD_ID,
        billing_line_item_id: null,
        event_type: "line_item_generated",
        actor_user_id: "22222222-2222-4222-8222-222222222222",
        created_at: "2026-04-25T10:00:00Z",
        details: { household_name: "HH-X" },
      },
    ];
    mockDirectoryRows = [
      {
        user_id: "22222222-2222-4222-8222-222222222222",
        email: "anonymous@example.test",
        first_name: null,
        last_name: null,
      },
    ];
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    const json = await res.json();
    expect(json.entries[0].actorDisplayName).toBe("anonymous@example.test");
  });

  it("actorDisplayName is null when the actor isn't returned by user_directory (super_admin hidden from org_manager)", async () => {
    mockAuditRows = [
      {
        id: "aaaaaaaa-4444-4111-8111-111111111111",
        billing_period_id: PERIOD_ID,
        billing_line_item_id: null,
        event_type: "line_item_generated",
        actor_user_id: "33333333-3333-4333-8333-333333333333",
        created_at: "2026-04-25T10:00:00Z",
        details: { household_name: "HH-X" },
      },
    ];
    // user_directory returns no row for the super_admin actor (RLS hides them
    // from org_managers via user_can_see_user_profile).
    mockDirectoryRows = [];
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    const json = await res.json();
    expect(json.entries[0].actorDisplayName).toBeNull();
    expect(json.entries[0].actorUserId).toBe(
      "33333333-3333-4333-8333-333333333333"
    );
  });

  it("audit row with deleted line item falls back to details.household_name snapshot", async () => {
    mockAuditRows = [
      {
        id: "aaaaaaaa-5555-4111-8111-111111111111",
        billing_period_id: PERIOD_ID,
        billing_line_item_id: null,
        event_type: "line_item_regenerated",
        actor_user_id: null,
        created_at: "2026-04-25T10:00:00Z",
        details: { household_name: "HH-Snapshot", new_total_amount: 0 },
      },
    ];
    const { GET } = await import("../route");
    const res = await GET(makeGetRequest(), {
      params: Promise.resolve({ periodId: PERIOD_ID }),
    });
    const json = await res.json();
    expect(json.entries[0].householdName).toBe("HH-Snapshot");
  });
});
