/**
 * user_directory_view.test.ts
 *
 * RLS-level visibility tests for the user_directory VIEW + user_profiles
 * policies introduced in UX5 (#79).
 *
 * Fixture: four users.
 *   A — super_admin
 *   B — org_manager @ NFE
 *   C — org_manager @ NFE
 *   D — org_manager @ OtherOrg
 *
 * Assertions:
 *   - A sees A, B, C, D.
 *   - B sees self + C. B does NOT see A (super_admins invisible to
 *     org_managers). B does NOT see D (different org).
 *   - D does NOT see B, C.
 *   - user_profiles UPDATE policy: B's attempt to update C's profile
 *     affects 0 rows (filtered by auth.uid() = user_id OR is_super_admin()).
 *
 * Opt-out: SKIP_RLS_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "./rls.helpers";

const FIXTURE = {
  nfe: "dddddddd-aaaa-4000-8000-000000000001",
  other: "dddddddd-bbbb-4000-8000-000000000001",
};

const emails = [
  "ux5-dir-a@test.local",
  "ux5-dir-b@test.local",
  "ux5-dir-c@test.local",
  "ux5-dir-d@test.local",
];

let A: TestUser, B: TestUser, C: TestUser, D: TestUser;

beforeAll(async () => {
  if (shouldSkip()) return;
  await assertEnvironmentReady();

  const svc = await serviceClient();
  await cleanupTestData({
    orgIds: [FIXTURE.nfe, FIXTURE.other],
    userEmails: emails,
  });

  const { error: orgErr } = await svc.from("organizations").insert([
    { id: FIXTURE.nfe, name: "UX5 NFE" },
    { id: FIXTURE.other, name: "UX5 OtherOrg" },
  ]);
  if (orgErr) throw new Error(`[fixture] orgs: ${orgErr.message}`);

  [A, B, C, D] = await Promise.all([
    createTestUser({ email: emails[0], role: "super_admin" }),
    createTestUser({
      email: emails[1],
      role: "org_manager",
      scopeId: FIXTURE.nfe,
    }),
    createTestUser({
      email: emails[2],
      role: "org_manager",
      scopeId: FIXTURE.nfe,
    }),
    createTestUser({
      email: emails[3],
      role: "org_manager",
      scopeId: FIXTURE.other,
    }),
  ]);

  // Seed user_profiles rows via service role. Migration 00017 adds an AFTER
  // INSERT trigger on auth.users that auto-creates an empty profile row, so
  // the rows already exist by the time we get here. Use upsert (ON CONFLICT
  // DO UPDATE) to overwrite the empty trigger-created rows with test values.
  const users = [A, B, C, D];
  const firstNames = ["Alice", "Bob", "Cara", "Dana"];
  const rows = users.map((u, i) => ({
    user_id: u.userId,
    first_name: firstNames[i],
  }));
  const { error: pErr } = await svc
    .from("user_profiles")
    .upsert(rows, { onConflict: "user_id" });
  if (pErr) throw new Error(`[fixture] user_profiles: ${pErr.message}`);
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;
  await cleanupTestData({
    orgIds: [FIXTURE.nfe, FIXTURE.other],
    userEmails: emails,
  });
}, 30_000);

function skipIfRequested(): boolean {
  if (shouldSkip()) {
    console.log("[user_directory_view] SKIP_RLS_TESTS=1 — skipping suite.");
    return true;
  }
  return false;
}

describe("user_directory — visibility", () => {
  it("A (super_admin) sees A, B, C, D", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await A.client
      .from("user_directory")
      .select("user_id")
      .in("user_id", [A.userId, B.userId, C.userId, D.userId]);
    expect(error).toBeNull();
    const ids = new Set((data ?? []).map((r) => r.user_id));
    expect(ids.has(A.userId)).toBe(true);
    expect(ids.has(B.userId)).toBe(true);
    expect(ids.has(C.userId)).toBe(true);
    expect(ids.has(D.userId)).toBe(true);
  });

  it("B (org_manager @ NFE) sees self + C; does NOT see A or D", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await B.client
      .from("user_directory")
      .select("user_id")
      .in("user_id", [A.userId, B.userId, C.userId, D.userId]);
    expect(error).toBeNull();
    const ids = new Set((data ?? []).map((r) => r.user_id));
    expect(ids.has(B.userId)).toBe(true);
    expect(ids.has(C.userId)).toBe(true);
    expect(ids.has(A.userId)).toBe(false); // super_admin hidden
    expect(ids.has(D.userId)).toBe(false); // different org
  });

  it("D (org_manager @ OtherOrg) does NOT see B, C", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await D.client
      .from("user_directory")
      .select("user_id")
      .in("user_id", [A.userId, B.userId, C.userId, D.userId]);
    expect(error).toBeNull();
    const ids = new Set((data ?? []).map((r) => r.user_id));
    expect(ids.has(D.userId)).toBe(true); // self
    expect(ids.has(B.userId)).toBe(false);
    expect(ids.has(C.userId)).toBe(false);
    expect(ids.has(A.userId)).toBe(false);
  });
});

describe("user_profiles — UPDATE policy", () => {
  it("org_manager B cannot UPDATE C's profile (0 rows → route maps to 403)", async () => {
    // RLS "Users edit own profile or super_admin edits any" policy returns 0
    // rows when an org_manager targets another user's profile. The route
    // PATCH /api/users/[id]/profile converts the 0-row result into HTTP 403
    // ("Not authorized to update this profile."). This test verifies the RLS
    // gate; route-level 403 mapping is confirmed by the route's `data.length === 0`
    // check in src/app/api/users/[id]/profile/route.ts.
    if (skipIfRequested()) return;

    const { data, error } = await B.client
      .from("user_profiles")
      .update({ first_name: "Hacked" })
      .eq("user_id", C.userId)
      .select("user_id");

    // RLS filters to zero rows; no error is thrown.
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);

    // Verify C's profile is unchanged.
    const svc = await serviceClient();
    const { data: cProf } = await svc
      .from("user_profiles")
      .select("first_name")
      .eq("user_id", C.userId)
      .maybeSingle();
    expect(cProf?.first_name).toBe("Cara");
  });

  it("org_manager B CAN UPDATE own profile", async () => {
    if (skipIfRequested()) return;

    const { data, error } = await B.client
      .from("user_profiles")
      .update({ first_name: "Bobby" })
      .eq("user_id", B.userId)
      .select("user_id");

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });

  it("super_admin A can UPDATE any profile", async () => {
    if (skipIfRequested()) return;

    const { data, error } = await A.client
      .from("user_profiles")
      .update({ first_name: "ChangedByAdmin" })
      .eq("user_id", D.userId)
      .select("user_id");

    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(1);
  });
});
