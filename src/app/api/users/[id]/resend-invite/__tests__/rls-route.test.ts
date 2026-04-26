/**
 * POST /api/users/[id]/resend-invite — RLS-mode integration test
 * (UX5b / #184).
 *
 * Why this exists in addition to route.test.ts:
 *
 * The unit suite (route.test.ts) mocks the user-bound Supabase client,
 * so .from("user_directory")…maybeSingle() returns whatever the test
 * declares — there is no RLS evaluation. Until 2026-04-24 the route
 * read `user_roles` directly; that table's SELECT policies grant only
 * "own row" + super_admin FOR ALL, so an org_manager B trying to
 * resend an org_manager C in the SAME org silently received NULL and
 * was 403'd at the orphan branch. Unit tests caught NONE of this
 * because the mock returned C's row regardless of identity.
 *
 * This file mints real JWTs (`rls.helpers.ts`) and runs the route
 * handler with a real RLS-bound user client, so the visibility helper
 * `user_can_see_user_profile(user_id)` (the WHERE clause behind the
 * `user_directory` view) is actually exercised. The service-role
 * client is mocked at the module level — `auth.admin.inviteUserByEmail`
 * is stubbed (no real email) and `auth.admin.getUserById` returns a
 * synthetic unconfirmed user (so the route reaches the invite call
 * instead of 409'ing on already-confirmed test users).
 *
 * Cases covered:
 *   - super_admin A → resend any user                  → 200
 *   - org_manager B (same org) → resend org_manager C → 200  ← the BLOCKER
 *   - org_manager B → resend org_manager D (other org) → 403
 *   - org_manager B → resend super_admin A             → 403
 *   - any caller   → resend nonexistent UUID           → 403
 *
 * Opt-out: SKIP_RLS_TESTS=1.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { NextRequest } from "next/server";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

// ── Mocks: server client and service client ───────────────────────────
//
// `currentTestUser` is swapped per-test via `setCaller(...)`. The mocked
// `createClient()` returns that user's RLS-bound Supabase client so the
// route handler executes against a real Postgres instance under the
// caller's JWT.
let currentCallerClient: TestUser["client"] | null = null;

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    if (!currentCallerClient) {
      throw new Error(
        "[rls-route.test] currentCallerClient not set; call setCaller() in the test"
      );
    }
    return currentCallerClient;
  },
}));

// Service-client mock: stub auth.admin.* so we don't actually send mail
// and so getUserById returns a synthetic unconfirmed user (the real test
// users created in beforeAll have email_confirmed_at != null and would
// 409 at the pre-check). The body of `getUserById` reflects whichever
// user we're targeting — set per test via `setTargetEmail`.
let mockTargetEmail = "rls-target@test.local";
let mockTargetUserId = "00000000-0000-0000-0000-000000000000";
let mockGetUserByIdError: { code?: string; message: string } | null = null;
const inviteSpy = vi.fn();

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: () => ({
    auth: {
      admin: {
        getUserById: vi.fn(async () => ({
          data: mockGetUserByIdError
            ? { user: null }
            : {
                user: {
                  id: mockTargetUserId,
                  email: mockTargetEmail,
                  email_confirmed_at: null,
                },
              },
          error: mockGetUserByIdError,
        })),
        inviteUserByEmail: vi.fn(async (...args: unknown[]) => {
          inviteSpy(...args);
          return {
            data: { user: { id: mockTargetUserId } },
            error: null,
          };
        }),
      },
    },
  }),
}));

// ── Fixture state ─────────────────────────────────────────────────────

const FIXTURE = {
  orgX: "ddddeeee-aaaa-4000-8000-000000000001",
  orgY: "ddddeeee-bbbb-4000-8000-000000000001",
};

const FIXTURE_EMAILS = [
  "ux5b-rls-super@test.local",
  "ux5b-rls-mgr-b@test.local",
  "ux5b-rls-mgr-c@test.local",
  "ux5b-rls-mgr-d@test.local",
];

let userSuper: TestUser;
let userMgrB: TestUser;
let userMgrC: TestUser;
let userMgrD: TestUser;

const NONEXISTENT_UUID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();

  const svc = await serviceClient();

  // Idempotent cleanup before insert.
  await cleanupTestData({
    orgIds: [FIXTURE.orgX, FIXTURE.orgY],
    userEmails: FIXTURE_EMAILS,
  });

  const { error: orgErr } = await svc.from("organizations").insert([
    { id: FIXTURE.orgX, name: "UX5b RLS Org X" },
    { id: FIXTURE.orgY, name: "UX5b RLS Org Y" },
  ]);
  if (orgErr) throw new Error(`[fixture] orgs: ${orgErr.message}`);

  [userSuper, userMgrB, userMgrC, userMgrD] = await Promise.all([
    createTestUser({ email: FIXTURE_EMAILS[0], role: "super_admin" }),
    createTestUser({
      email: FIXTURE_EMAILS[1],
      role: "org_manager",
      scopeId: FIXTURE.orgX,
    }),
    createTestUser({
      email: FIXTURE_EMAILS[2],
      role: "org_manager",
      scopeId: FIXTURE.orgX,
    }),
    createTestUser({
      email: FIXTURE_EMAILS[3],
      role: "org_manager",
      scopeId: FIXTURE.orgY,
    }),
  ]);
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanupTestData({
    orgIds: [FIXTURE.orgX, FIXTURE.orgY],
    userEmails: FIXTURE_EMAILS,
  });
}, 30_000);

beforeEach(() => {
  inviteSpy.mockReset();
  currentCallerClient = null;
  mockGetUserByIdError = null;
  mockTargetEmail = "rls-target@test.local";
  mockTargetUserId = "00000000-0000-0000-0000-000000000000";
});

// ── Helpers ───────────────────────────────────────────────────────────

function makeRequest(id: string): NextRequest {
  return new NextRequest(
    `http://localhost/api/users/${id}/resend-invite`,
    { method: "POST" }
  );
}

function makeContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

function setCaller(u: TestUser) {
  currentCallerClient = u.client;
}

function setTarget(u: TestUser) {
  mockTargetUserId = u.userId;
  mockTargetEmail = `synthetic-${u.userId.slice(0, 8)}@test.local`;
}

function skipIfRequested(): boolean {
  if (shouldSkip()) {
    // The harness skips at the file level only when SKIP_RLS_TESTS=1
    // and the suite-level beforeAll early-returns. Per-test guard is
    // redundant but matches the pattern in user_directory_view.test.ts.
    console.log("[rls-route] SKIP_RLS_TESTS=1 — skipping case.");
    return true;
  }
  return false;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("POST /api/users/[id]/resend-invite (RLS mode)", () => {
  it("super_admin A → resend org_manager C → 200", async () => {
    if (skipIfRequested()) return;
    setCaller(userSuper);
    setTarget(userMgrC);

    const { POST } = await import("../route");
    const res = await POST(makeRequest(userMgrC.userId), makeContext(userMgrC.userId));
    expect(res.status).toBe(200);
    expect(inviteSpy).toHaveBeenCalledTimes(1);
  });

  it("org_manager B (same org) → resend org_manager C → 200 (BLOCKER coverage)", async () => {
    // This is the case the unit-test mock paved over: pre-fix, the route
    // read `user_roles` directly and B saw NULL for C's row → orphan
    // branch → 403. With user_directory the visibility helper grants B
    // visibility on C → org_manager target branch → currentUserCanAccessOrg
    // succeeds → 200.
    if (skipIfRequested()) return;
    setCaller(userMgrB);
    setTarget(userMgrC);

    const { POST } = await import("../route");
    const res = await POST(makeRequest(userMgrC.userId), makeContext(userMgrC.userId));
    expect(res.status).toBe(200);
    expect(inviteSpy).toHaveBeenCalledTimes(1);
  });

  it("org_manager B → resend org_manager D (different org) → 403", async () => {
    if (skipIfRequested()) return;
    setCaller(userMgrB);
    setTarget(userMgrD);

    const { POST } = await import("../route");
    const res = await POST(makeRequest(userMgrD.userId), makeContext(userMgrD.userId));
    expect(res.status).toBe(403);
    expect(inviteSpy).not.toHaveBeenCalled();
  });

  it("org_manager B → resend super_admin A → 403", async () => {
    if (skipIfRequested()) return;
    setCaller(userMgrB);
    setTarget(userSuper);

    const { POST } = await import("../route");
    const res = await POST(makeRequest(userSuper.userId), makeContext(userSuper.userId));
    expect(res.status).toBe(403);
    expect(inviteSpy).not.toHaveBeenCalled();
  });

  it("org_manager B → resend nonexistent UUID → 403 (uniform with cross-org)", async () => {
    // Enumeration defense: invisible-to-caller and doesn't-exist must
    // be indistinguishable from outside. Both produce 403.
    if (skipIfRequested()) return;
    setCaller(userMgrB);
    // getUserById would return user_not_found if reached, but the route
    // MUST short-circuit on the visibility miss BEFORE calling it.
    mockGetUserByIdError = { code: "user_not_found", message: "not found" };

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest(NONEXISTENT_UUID),
      makeContext(NONEXISTENT_UUID)
    );
    expect(res.status).toBe(403);
    expect(inviteSpy).not.toHaveBeenCalled();
  });

  it("super_admin A → resend nonexistent UUID → 404 (visibility passes; lookup misses)", async () => {
    // For super_admin the `user_directory` row is also NULL on a
    // nonexistent UUID, so the route's "no row + caller is super" branch
    // proceeds to getUserById, which surfaces 404. This documents the
    // intentional asymmetry: super_admin gets the canonical 404; everyone
    // else gets 403.
    if (skipIfRequested()) return;
    setCaller(userSuper);
    mockGetUserByIdError = { code: "user_not_found", message: "not found" };

    const { POST } = await import("../route");
    const res = await POST(
      makeRequest(NONEXISTENT_UUID),
      makeContext(NONEXISTENT_UUID)
    );
    expect(res.status).toBe(404);
    expect(inviteSpy).not.toHaveBeenCalled();
  });
});
