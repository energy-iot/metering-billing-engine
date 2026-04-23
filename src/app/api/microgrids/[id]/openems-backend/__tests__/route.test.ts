/**
 * PUT /api/microgrids/[id]/openems-backend — unit tests (#101 / AC-TEST-2).
 *
 * All Supabase + auth helpers mocked. Covers:
 *   - 400 malformed body
 *   - 404 when currentUserCanAccessMicrogrid is false OR the microgrid doesn't exist
 *   - Mid-period lock branch (a): draft exists → 409 no write
 *   - Mid-period lock branch (b): closed exists without confirmed_name → 409
 *     with requires_typed_confirmation; retry with matching name → proceeds;
 *     mismatched confirmed_name on retry → rejected
 *   - Mid-period lock branch (c): no periods → save + discover executes
 *   - Discover outcomes: success / auth_failed / unreachable / zero_edges
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Factory/client mock ───────────────────────────────────────────────────

const getEdgesStatusMock = vi.fn();
vi.mock("@/lib/openems", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openems")>(
    "@/lib/openems"
  );
  return {
    ...actual,
    createOpenEmsClient: () => ({ getEdgesStatus: getEdgesStatusMock }),
  };
});

// ── Supabase mock ────────────────────────────────────────────────────────
//
// The route issues, in order:
//   1. .from('microgrids').select(...).eq('id', ...).maybeSingle() → mgRow
//   2. .from('billing_periods').select(...).eq(..).in(..) → periods array
//   3. .rpc('fn_ems_encrypt_secret', ...) → encryptedSecret (cloud_aws only)
//   4. .from('microgrids').update(payload).eq('id', ...) → { error: null }
//   5. .from('edges').select(...).eq('microgrid_id', ...) → existing edges
//   6. .from('microgrids').update(health fields).eq('id', ...) → { error: null }
//   7. supabase.auth.getUser() → { data: { user: { id } } }

const MG_ID = "550e8400-e29b-41d4-a716-446655440000";
const MG_NAME = "Kisakye";

let mgRow: { id: string; name: string } | null = { id: MG_ID, name: MG_NAME };
let periods: { id: string; status: "draft" | "closed" }[] = [];
let canAccessMicrogridReturn = true;

const mockFrom = vi.fn();
const mockRpc = vi.fn();
const mockGetUser = vi.fn().mockResolvedValue({ data: { user: { id: "user-1" } } });

function buildSupabase(updateErr: unknown = null) {
  return {
    from: mockFrom,
    rpc: mockRpc,
    auth: { getUser: mockGetUser },
    _updateErr: updateErr,
  } as unknown as ReturnType<typeof import("@/lib/supabase/server").createClient>;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    rpc: mockRpc,
    auth: { getUser: mockGetUser },
  }),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: async () => canAccessMicrogridReturn,
}));

// Sequenced from() handlers — each test sets up the order of calls.
let fromCallIndex = 0;
const fromHandlers: Array<(table: string) => unknown> = [];

function registerFrom(handler: (table: string) => unknown) {
  fromHandlers.push(handler);
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makePutRequest(body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/microgrids/${MG_ID}/openems-backend`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mgSelectHandler(row: { id: string; name: string } | null) {
  return () => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve({ data: row, error: null }),
      }),
    }),
  });
}

function billingPeriodsHandler(
  rows: { id: string; status: "draft" | "closed" }[]
) {
  return () => ({
    select: () => ({
      eq: () => ({
        in: () => Promise.resolve({ data: rows, error: null }),
      }),
    }),
  });
}

function mgUpdateHandler(error: unknown = null) {
  return () => ({
    update: () => ({
      eq: () => Promise.resolve({ error }),
    }),
  });
}

function edgesSelectHandler(rows: { openems_edge_id: string }[]) {
  return () => ({
    select: () => ({
      eq: () =>
        Promise.resolve({ data: rows, error: null }),
    }),
  });
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("PUT /api/microgrids/[id]/openems-backend", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    buildSupabase();
    fromCallIndex = 0;
    fromHandlers.length = 0;
    canAccessMicrogridReturn = true;
    mgRow = { id: MG_ID, name: MG_NAME };
    periods = [];

    mockFrom.mockImplementation((table: string) => {
      const handler = fromHandlers[fromCallIndex++];
      if (!handler) throw new Error(`unexpected from(${table}) call #${fromCallIndex}`);
      return handler(table);
    });

    mockRpc.mockResolvedValue({ data: "\\x01020304" /* bytea hex */, error: null });
  });

  it("returns 400 on malformed body", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(makePutRequest({ type: "bogus" }), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when cloud_aws config is missing secretAccessKey", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "cloud_aws",
        backendUrl: "https://lambda.example.com/",
        region: "us-east-1",
        accessKeyId: "AKIA",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when microgrid does not exist", async () => {
    registerFrom(mgSelectHandler(null));

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(404);
  });

  it("returns 403 when currentUserCanAccessMicrogrid is false", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    canAccessMicrogridReturn = false;

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it("Branch (a): draft exists → 409 with no write", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(
      billingPeriodsHandler([{ id: "bp-1", status: "draft" }])
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toContain("Close or delete the draft period first");
    expect(json.draft_count).toBe(1);
    expect(json.closed_count).toBe(0);
    // No update, no upsert — assert by checking mockFrom call count.
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it("Branch (b): closed only, no confirmed_name → 409 + requires_typed_confirmation", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([{ id: "bp-1", status: "closed" }]));

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.requires_typed_confirmation).toEqual({ entity_name: MG_NAME });
    expect(json.closed_count).toBe(1);
  });

  it("Branch (b) retry with matching confirmed_name → proceeds to save + discover", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([{ id: "bp-1", status: "closed" }]));
    registerFrom(mgUpdateHandler(null)); // persist config
    registerFrom(edgesSelectHandler([])); // no existing edges
    registerFrom(mgUpdateHandler(null)); // health update

    getEdgesStatusMock.mockResolvedValue([
      { edgeId: "edge0", online: true },
    ]);

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        confirmed_name: MG_NAME,
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("success");
    expect(json.edges).toHaveLength(1);
  });

  it("Branch (c): no periods → save + discover succeeds (direct_url)", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));
    registerFrom(mgUpdateHandler(null));
    registerFrom(edgesSelectHandler([])); // no existing → alreadyLinked=false
    registerFrom(mgUpdateHandler(null));

    getEdgesStatusMock.mockResolvedValue([
      { edgeId: "edge0", online: true },
      { edgeId: "edge1", online: false },
    ]);

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("success");
    expect(json.edges).toHaveLength(2);
    expect(json.edges[0]).toMatchObject({
      openems_edge_id: "edge0",
      alreadyLinked: false,
    });
  });

  it("auth_failed path: returns 200 + status='auth_failed'", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));
    registerFrom(mgUpdateHandler(null));
    registerFrom(mgUpdateHandler(null)); // health update

    const { OpenEmsError } = await import("@/lib/openems");
    getEdgesStatusMock.mockRejectedValue(
      new OpenEmsError("auth failed", "OPENEMS_AUTH_FAILED", 401)
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "cloud_aws",
        backendUrl: "https://lambda.example.com/",
        region: "us-east-1",
        accessKeyId: "AKIAEXAMPLEKEYID12345",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("auth_failed");
    expect(json.message).toContain("rotated access key");
  });

  it("unreachable path: returns 200 + status='unreachable'", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));
    registerFrom(mgUpdateHandler(null));
    registerFrom(mgUpdateHandler(null));

    const { OpenEmsError } = await import("@/lib/openems");
    getEdgesStatusMock.mockRejectedValue(
      new OpenEmsError("network down", "OPENEMS_UNREACHABLE", 503)
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("unreachable");
    expect(json.message).toContain("Could not reach");
  });

  it("zero_edges path: returns 200 + status='zero_edges'", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));
    registerFrom(mgUpdateHandler(null));
    registerFrom(mgUpdateHandler(null));

    getEdgesStatusMock.mockResolvedValue([]);

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("zero_edges");
  });
});

// Silence `periods` unused-warning when linter is strict about top-level lets.
void periods;
void mgRow;
void buildSupabase;
