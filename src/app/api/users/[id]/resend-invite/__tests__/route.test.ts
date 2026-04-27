/**
 * POST /api/users/[id]/resend-invite — route handler unit tests
 * (UX5b / #184).
 *
 * Mocks Supabase user-bound + service clients. Covers (mirroring AC1
 * Steps A→G):
 *   - 200: happy path (super_admin → org_manager target).
 *   - 401: no caller session.
 *   - 403: org_manager → super_admin target.
 *   - 403: org_manager → cross-org org_manager target.
 *   - 403: org_manager → orphan target (no role row).
 *   - 404: target not found in auth.users (lookup AFTER permission has passed).
 *   - 409: pre-check email_confirmed_at IS NOT NULL.
 *   - 409: race — GoTrue returns email_exists.
 *   - 429: rate-limit by error.code.
 *   - 429: rate-limit by message-text fallback.
 *   - 422: any other GoTrue error.
 *   - Ordering: when permission would 403 AND target also doesn't
 *     exist, the route MUST 403 (permission-before-lookup).
 *   - 400: invalid UUID in path.
 *
 * The two-client pattern is mocked via vi.mock() with mutable handles
 * the tests reset in beforeEach.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ── Mocks ────────────────────────────────────────────────────────────

// Caller user (auth.getUser result).
let mockCaller: { id: string; email?: string } | null = null;

// Mock for the user-bound client `.from("user_directory").select(...).eq(...).maybeSingle()`
// Returns the target's CURRENT row (or null when invisible/absent). The
// route was migrated from `user_roles` → `user_directory` because the
// former's RLS policies block org_manager → org_manager-in-same-org reads;
// the view's WHERE filter (`user_can_see_user_profile(user_id)`) is the
// canonical visibility gate. A visible orphan surfaces as a row with
// NULL role/scope columns (LEFT JOIN miss on user_roles).
let mockTargetRoleRow: {
  role: "super_admin" | "org_manager" | null;
  scope_type: "org" | null;
  scope_id: string | null;
} | null = null;

// Roles for the caller (used by access.ts helpers via the same mock from()).
let mockCallerRoles: Array<{
  role: "super_admin" | "org_manager";
  scope_type: "org" | null;
  scope_id: string | null;
}> = [];

// Mock for service-client svc.auth.admin.getUserById
let mockGetUserByIdResult: {
  data: { user: { id: string; email: string; email_confirmed_at: string | null } | null };
  error: { code?: string; message: string } | null;
} = { data: { user: null }, error: { code: "user_not_found", message: "not found" } };

// Mock for service-client svc.auth.admin.inviteUserByEmail
let mockInviteResult: {
  data: { user: { id: string } | null };
  error: { code?: string; message: string } | null;
} = { data: { user: null }, error: null };

// Spy capturing the inviteUserByEmail args for shape assertions.
const inviteUserByEmailSpy = vi.fn();

// User-bound client `.from('user_profiles')` and `.from('organizations')`
// chains used by buildInviteDataPayload — return permissive defaults.
function userClientFromImpl(table: string) {
  if (table === "user_profiles") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: vi.fn(async () => ({
            data: { first_name: "Test", last_name: "Caller" },
            error: null,
          })),
        }),
      }),
    };
  }
  if (table === "organizations") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: vi.fn(async () => ({
            data: { name: "Test Org" },
            error: null,
          })),
        }),
      }),
    };
  }
  if (table === "user_directory") {
    // Target lookup. `eq("user_id", targetId).maybeSingle()`.
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: vi.fn(async () => ({
            data: mockTargetRoleRow,
            error: null,
          })),
        }),
      }),
    };
  }
  if (table === "user_roles") {
    // After the route migration, only access.ts's `getCurrentUserRoles`
    // (caller-roles fetch) reads user_roles via the user-bound client.
    // The chain is `select("*").eq("user_id", caller.id).returns()`.
    return {
      select: () => ({
        eq: () => ({
          returns: () =>
            Promise.resolve({ data: mockCallerRoles, error: null }),
        }),
      }),
    };
  }
  throw new Error(`Unexpected table in userClient: ${table}`);
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: vi.fn(userClientFromImpl),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: mockCaller },
        error: null,
      })),
    },
  }),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    auth: {
      admin: {
        getUserById: vi.fn(async () => mockGetUserByIdResult),
        inviteUserByEmail: vi.fn(async (...args: unknown[]) => {
          inviteUserByEmailSpy(...args);
          return mockInviteResult;
        }),
      },
    },
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────

const CALLER_UUID = "11111111-1111-4000-8000-000000000001";
const TARGET_UUID = "22222222-2222-4000-8000-000000000002";
const ORG_A = "aaaaaaaa-aaaa-4000-8000-000000000001";
const ORG_B = "bbbbbbbb-bbbb-4000-8000-000000000002";

function makeRequest(id: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/users/${id}/resend-invite`,
    { method: "POST" }
  );
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  inviteUserByEmailSpy.mockReset();
  mockCaller = { id: CALLER_UUID, email: "caller@example.com" };
  mockCallerRoles = [];
  mockTargetRoleRow = null;
  mockGetUserByIdResult = {
    data: { user: null },
    error: { code: "user_not_found", message: "not found" },
  };
  mockInviteResult = { data: { user: { id: TARGET_UUID } }, error: null };
});

// ── Tests ────────────────────────────────────────────────────────────

describe("POST /api/users/[id]/resend-invite", () => {
  // ── 400: invalid UUID ─────────────────────────────────────────────
  it("returns 400 for a malformed UUID in the path", async () => {
    const { POST } = await import("../route");
    const res = await POST(makeRequest("not-a-uuid"), makeContext("not-a-uuid"));
    expect(res.status).toBe(400);
  });

  // ── 401: no session ──────────────────────────────────────────────
  it("returns 401 when no caller session is present", async () => {
    mockCaller = null;
    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toMatch(/auth/i);
  });

  // ── 403: org_manager → super_admin target ───────────────────────
  it("returns 403 when org_manager attempts to resend a super_admin", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = { role: "super_admin", scope_type: null, scope_id: null };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
  });

  // ── 403: org_manager → cross-org org_manager ────────────────────
  it("returns 403 when org_manager attempts to resend an org_manager scoped to a different org", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_B };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
  });

  // ── 403: org_manager → orphan (no role row) ─────────────────────
  // Either the target genuinely has no role row, OR RLS hid it. Uniform 403.
  it("returns 403 when org_manager hits an orphan target (null role row)", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = null;

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
  });

  // ── Permission-before-lookup ordering ──────────────────────────
  // A non-existent target combined with insufficient permission MUST 403,
  // not 404. This prevents an attacker from probing UUIDs via 404s.
  it("returns 403 (NOT 404) when target doesn't exist AND caller lacks permission", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = null; // target has no role row OR RLS-hidden
    // getUserById would return user_not_found if reached, but the route
    // MUST short-circuit on the permission failure before calling it.
    mockGetUserByIdResult = {
      data: { user: null },
      error: { code: "user_not_found", message: "not found" },
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(403);
  });

  // ── 404: missing auth user (only after permission has passed) ──
  it("returns 404 when the target user does not exist in auth.users (super_admin caller)", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = null; // orphan path, super_admin allowed
    mockGetUserByIdResult = {
      data: { user: null },
      error: { code: "user_not_found", message: "not found" },
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(404);
  });

  it("returns 404 when getUserById returns null user with no error code", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = null;
    mockGetUserByIdResult = { data: { user: null }, error: null };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(404);
  });

  // ── 409: already accepted (pre-check) ──────────────────────────
  it("returns 409 when the target has already accepted (email_confirmed_at not null)", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: "2026-04-24T00:00:00Z",
        },
      },
      error: null,
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already accepted/i);
    expect(inviteUserByEmailSpy).not.toHaveBeenCalled();
  });

  // ── 409: race — GoTrue returns email_exists ────────────────────
  it("returns 409 when GoTrue races on email_exists (target confirmed mid-flight)", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    mockInviteResult = {
      data: { user: null },
      error: { code: "email_exists", message: "already registered" },
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error).toMatch(/already accepted/i);
  });

  // ── 429: rate-limit by error.code ──────────────────────────────
  it("returns 429 with code: rate_limited when GoTrue surfaces over_email_send_rate_limit", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    mockInviteResult = {
      data: { user: null },
      error: {
        code: "over_email_send_rate_limit",
        message: "rate limit exceeded",
      },
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("rate_limited");
    expect(json.error).toMatch(/try again/i);
  });

  // ── 429: rate-limit by message-text fallback (no code) ─────────
  it("returns 429 when older SDK omits code but message contains 'rate limit'", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    mockInviteResult = {
      data: { user: null },
      error: { message: "Email rate limit reached" }, // no code
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.code).toBe("rate_limited");
  });

  // ── 422: other GoTrue error ────────────────────────────────────
  it("returns 422 for any other GoTrue error", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    mockInviteResult = {
      data: { user: null },
      error: { code: "unexpected_failure", message: "something else" },
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toMatch(/Resend failed/i);
  });

  // ── 200: happy path (super_admin → org_manager target) ────────
  it("returns 200 { resent: true } and forwards data payload to GoTrue", async () => {
    mockCallerRoles = [{ role: "super_admin", scope_type: null, scope_id: null }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "target@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    mockInviteResult = {
      data: { user: { id: TARGET_UUID } },
      error: null,
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.resent).toBe(true);

    // Verify the data payload was forwarded with the expected shape.
    expect(inviteUserByEmailSpy).toHaveBeenCalledTimes(1);
    const [emailArg, optsArg] = inviteUserByEmailSpy.mock.calls[0]!;
    expect(emailArg).toBe("target@example.com");
    expect(optsArg).toMatchObject({
      data: {
        invited_by_name: expect.any(String),
        org_name: "Test Org",
        role_label: "an organization manager",
        app_name: "Metering & Billing Engine",
      },
      // UX5c / #189 — per-call redirectTo so resends land on the same
      // /accept-invite page as fresh invites.
      redirectTo: "http://localhost/accept-invite",
    });
  });

  // ── 200: org_manager resending an org_manager in their org ──────
  it("allows org_manager to resend an org_manager in their org", async () => {
    mockCallerRoles = [{ role: "org_manager", scope_type: "org", scope_id: ORG_A }];
    mockTargetRoleRow = { role: "org_manager", scope_type: "org", scope_id: ORG_A };
    mockGetUserByIdResult = {
      data: {
        user: {
          id: TARGET_UUID,
          email: "peer@example.com",
          email_confirmed_at: null,
        },
      },
      error: null,
    };
    mockInviteResult = {
      data: { user: { id: TARGET_UUID } },
      error: null,
    };

    const { POST } = await import("../route");
    const res = await POST(makeRequest(TARGET_UUID), makeContext(TARGET_UUID));
    expect(res.status).toBe(200);
  });
});
