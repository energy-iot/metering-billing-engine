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
let isSuperAdminReturn = true;

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
  currentUserIsSuperAdmin: async () => isSuperAdminReturn,
}));

// The EMS secret decrypt runs on the service-role client (migration 00049).
// `getEmsSecretForMicrogrid` performs its own RLS row read on the user client
// first, so the preserve-secret path now issues an EXTRA from('microgrids')
// before this RPC — see the handler ordering in that test.
const mockServiceRpc = vi.fn();
vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({ rpc: mockServiceRpc }),
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

function mgSelectHandler(
  row: {
    id: string;
    name: string;
    ems_type?: "cloud_aws" | "direct_url" | null;
    ems_aws_secret_access_key_encrypted?: string | null;
  } | null
) {
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
    isSuperAdminReturn = true;
    mgRow = { id: MG_ID, name: MG_NAME };
    periods = [];

    mockFrom.mockImplementation((table: string) => {
      const handler = fromHandlers[fromCallIndex++];
      if (!handler) throw new Error(`unexpected from(${table}) call #${fromCallIndex}`);
      return handler(table);
    });

    // The user client only ever issues fn_ems_encrypt_secret now.
    mockRpc.mockImplementation(() =>
      Promise.resolve({ data: "\\x01020304", error: null })
    );

    mockServiceRpc.mockImplementation(() =>
      Promise.resolve({ data: "DECRYPTED_FAKE_SECRET", error: null })
    );
  });

  it("returns 400 on malformed body", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(makePutRequest({ type: "bogus" }), {
      params: Promise.resolve({ id: MG_ID }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when cloud_aws config is missing secretAccessKey AND no existing ciphertext", async () => {
    // Route now reads the microgrid row first to check for an existing
    // ciphertext (#102 secret-preserve). When none exists, blank secret
    // still yields 400.
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([])); // not hit; left here for safety

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "cloud_aws",
        backendUrl: "https://lambda.example.com/",
        region: "us-east-1",
        accessKeyId: "AKIA",
        known_edge_ids: [],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when known_edge_ids is not an array", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: "edge0,edge1", // string, not array
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("known_edge_ids must be an array");
  });

  it("returns 400 when known_edge_ids is missing entirely", async () => {
    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        // known_edge_ids intentionally omitted
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("known_edge_ids must be an array");
  });

  it("returns 404 when microgrid does not exist", async () => {
    registerFrom(mgSelectHandler(null));

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: [],
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
        known_edge_ids: [],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(403);
  });

  it("returns 403 with super_admin message when org_manager calls PUT (Nit #1 security gate)", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    // org_manager can access the microgrid but is not super_admin
    canAccessMicrogridReturn = true;
    isSuperAdminReturn = false;

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: [],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe("Only super admins can update OpenEMS backend config.");
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
        known_edge_ids: [],
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
        known_edge_ids: [],
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
        known_edge_ids: ["edge0"],
        confirmed_name: MG_NAME,
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("success");
    expect(json.edges).toHaveLength(1);
  });

  it("Branch (b) retry with mismatched confirmed_name → 400 with mismatch error", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([{ id: "bp-1", status: "closed" }]));

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: [],
        confirmed_name: "WrongName",
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("does not match");
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
        known_edge_ids: ["edge0", "edge1"],
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

  it("auth_failed path (step 5 edge validation): returns 503 + reason='auth_failed', persist NOT called", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));

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
        known_edge_ids: ["edge0"],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.reason).toBe("auth_failed");
    expect(json.error).toContain("rotated access key");
    // No UPDATE should have been called — only mgSelect + billingPeriods (2 from() calls)
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it("unreachable path (step 5 edge validation): returns 503 + reason='unreachable', persist NOT called", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));

    const { OpenEmsError } = await import("@/lib/openems");
    getEdgesStatusMock.mockRejectedValue(
      new OpenEmsError("network down", "OPENEMS_UNREACHABLE", 503)
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: ["edge0"],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.reason).toBe("unreachable");
    expect(json.error).toContain("Could not reach");
    // No UPDATE should have been called — only mgSelect + billingPeriods (2 from() calls)
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it("step 5 OPENEMS_AUTH_FAILED → 503 with { error, reason: 'auth_failed' }; persist NOT called", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));

    const { OpenEmsError } = await import("@/lib/openems");
    getEdgesStatusMock.mockRejectedValue(
      new OpenEmsError("auth failed", "OPENEMS_AUTH_FAILED", 401)
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: ["edge0"],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json).toMatchObject({ reason: "auth_failed" });
    expect(typeof json.error).toBe("string");
    // Persist (microgrids UPDATE) must NOT have been called.
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it("zero_edges path: empty known_edge_ids → skip RPC, return zero_edges without calling getEdgesStatus", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));
    registerFrom(mgUpdateHandler(null)); // persist config
    registerFrom(mgUpdateHandler(null)); // health update

    // getEdgesStatus should NOT be called when known_edge_ids is empty
    getEdgesStatusMock.mockResolvedValue([]);

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: [], // empty list → skip RPC
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("zero_edges");
    expect(json.message).toContain("No edges declared yet");
    // Verify getEdgesStatus was NOT called (empty list skips the round-trip)
    expect(getEdgesStatusMock).not.toHaveBeenCalled();
  });

  // AC-TEST-PRESERVE (#102): "Leave blank to keep the current secret"
  it("preserve-secret: blank secretAccessKey + existing ciphertext → no re-encrypt, existing secret used for Discover", async () => {
    registerFrom(
      mgSelectHandler({
        id: MG_ID,
        name: MG_NAME,
        ems_type: "cloud_aws",
        // sentinel non-null bytea hex representation
        ems_aws_secret_access_key_encrypted: "\\x01020304",
      })
    );
    registerFrom(billingPeriodsHandler([]));
    // getEmsSecretForMicrogrid's authorization read — the RLS row read that
    // must precede the service-role decrypt.
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(mgUpdateHandler(null)); // persist config (WITHOUT re-encrypt)
    registerFrom(edgesSelectHandler([]));
    registerFrom(mgUpdateHandler(null)); // health

    getEdgesStatusMock.mockResolvedValue([
      { edgeId: "edge0", online: true },
    ]);

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "cloud_aws",
        backendUrl: "https://lambda.example.com/",
        region: "us-east-1",
        accessKeyId: "AKIAEXAMPLEKEYID12345",
        known_edge_ids: ["edge0"],
        // NO secretAccessKey — preserve branch
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("success");

    // The decrypt happens on the SERVICE-ROLE client (00049), never on the
    // user client. The preserve branch skips re-encryption entirely.
    const userRpcCalls = mockRpc.mock.calls.map((c) => c[0]);
    expect(userRpcCalls).not.toContain("fn_get_ems_secret");
    expect(userRpcCalls).not.toContain("fn_ems_encrypt_secret");

    const serviceRpcCalls = mockServiceRpc.mock.calls.map((c) => c[0]);
    expect(serviceRpcCalls).toContain("fn_get_ems_secret");
  });

  it("preserve-secret: blank secretAccessKey + NO existing ciphertext → 400", async () => {
    registerFrom(
      mgSelectHandler({
        id: MG_ID,
        name: MG_NAME,
        ems_type: null,
        ems_aws_secret_access_key_encrypted: null,
      })
    );

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "cloud_aws",
        backendUrl: "https://lambda.example.com/",
        region: "us-east-1",
        accessKeyId: "AKIAEXAMPLEKEYID12345",
        known_edge_ids: [],
        // NO secretAccessKey
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("secretAccessKey");
  });

  // AC-TEST-EDGE-IDS (#112): edge-ID validation tests
  it("edge-ID validation: one invalid ID → 400 with invalid_edges, row NOT updated", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));

    // Backend returns edge0 but NOT edgeX
    getEdgesStatusMock.mockResolvedValue([{ edgeId: "edge0", online: true }]);

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: ["edge0", "edgeX"],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("not found on the backend");
    expect(json.invalid_edges).toEqual(["edgeX"]);
    // No UPDATE should have been called — only mgSelect + billingPeriods
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it("edge-ID validation: valid mix of online+offline → save succeeds", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));
    registerFrom(mgUpdateHandler(null)); // persist
    registerFrom(edgesSelectHandler([]));
    registerFrom(mgUpdateHandler(null)); // health

    // Both edge0 (online) and edge1 (offline) present in response
    getEdgesStatusMock.mockResolvedValue([
      { edgeId: "edge0", online: true },
      { edgeId: "edge1", online: false },
    ]);

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: ["edge0", "edge1"],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe("success");
    // Message mentions offline count
    expect(json.message).toContain("offline");
    expect(json.edges).toHaveLength(2);
  });

  it("edge-ID validation: all IDs invalid → 400, ems_type stays unchanged", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));

    // Backend returns empty — all IDs unknown
    getEdgesStatusMock.mockResolvedValue([]);

    const { PUT } = await import("../route");
    const res = await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: ["edgeA", "edgeB"],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.invalid_edges).toEqual(["edgeA", "edgeB"]);
    // No DB write — only 2 from() calls (select + billingPeriods)
    expect(mockFrom).toHaveBeenCalledTimes(2);
  });

  it("known_edge_ids_count appears in the success log payload (validates log hygiene)", async () => {
    registerFrom(mgSelectHandler({ id: MG_ID, name: MG_NAME }));
    registerFrom(billingPeriodsHandler([]));
    registerFrom(mgUpdateHandler(null));
    registerFrom(edgesSelectHandler([]));
    registerFrom(mgUpdateHandler(null));

    getEdgesStatusMock.mockResolvedValue([
      { edgeId: "edge0", online: true },
    ]);

    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

    const { PUT } = await import("../route");
    await PUT(
      makePutRequest({
        type: "direct_url",
        backendUrl: "http://localhost:8075",
        known_edge_ids: ["edge0"],
      }),
      { params: Promise.resolve({ id: MG_ID }) }
    );

    const logCalls = infoSpy.mock.calls.map((c) => JSON.parse(c[0] as string));
    const saveLog = logCalls.find(
      (l) => l.event === "openems.save_and_test"
    );
    expect(saveLog).toBeDefined();
    expect(saveLog.known_edge_ids_count).toBe(1);
    infoSpy.mockRestore();
  });
});

// Silence `periods` unused-warning when linter is strict about top-level lets.
void periods;
void mgRow;
void buildSupabase;
