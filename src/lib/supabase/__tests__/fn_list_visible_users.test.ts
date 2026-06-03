/**
 * fn_list_visible_users.test.ts
 *
 * RLS-level visibility tests for the `fn_list_visible_users` RPC + the
 * `user_profiles` UPDATE policy. Migration 00046 (#269) replaced the
 * prior `user_directory` VIEW with this RPC to clear two CRITICAL
 * Supabase linter ERRORs (`auth_users_exposed` + `security_definer_view`).
 *
 * Meaningful security upgrade over the dropped view: anon was previously
 * granted SELECT on the view (rows-filtered by the WHERE clause → 0
 * rows in practice). The new RPC denies anon at the grant layer
 * (REVOKE EXECUTE FROM PUBLIC, anon) → 42501 / "permission denied".
 *
 * Fixture: four users.
 *   A — super_admin
 *   B — org_manager @ NFE
 *   C — org_manager @ NFE
 *   D — org_manager @ OtherOrg
 *
 * Coverage (per the architect appendix on #269):
 *   - Anon `.rpc("fn_list_visible_users")` → permission-denied error
 *     (NEW security shape vs. the old "0 rows" behaviour).
 *   - Super_admin sees all visible users (including super_admins).
 *   - Org_manager sees own-org users only (super_admins + cross-org hidden).
 *   - Single-target lookup: `_target_user_ids: [<otherOrgUserId>]` returns
 *     empty for org_manager; returns the row for super_admin.
 *   - Batch lookup: `_target_user_ids: [a,b,c]` returns ≤3 rows depending
 *     on per-id visibility (preserves the audit-log-fetch use case).
 *   - user_profiles UPDATE policy: org_manager B's attempt to update C's
 *     profile affects 0 rows (unchanged from the prior suite).
 *
 * Opt-out: SKIP_RLS_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  LOCAL_SUPABASE_URL,
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
    console.log("[fn_list_visible_users] SKIP_RLS_TESTS=1 — skipping suite.");
    return true;
  }
  return false;
}

type VisibleRow = {
  user_id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
};

describe("fn_list_visible_users — visibility", () => {
  it("anon cannot call the RPC (permission denied at the grant layer)", async () => {
    if (skipIfRequested()) return;
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!anonKey) throw new Error("NEXT_PUBLIC_SUPABASE_ANON_KEY not set");
    // Anon client: no Authorization bearer, only the apikey. RPC must
    // 42501 / "permission denied" — this is the MEANINGFUL security
    // upgrade over the dropped view (which returned 0 rows via filter).
    const anon = createClient(LOCAL_SUPABASE_URL, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await anon.rpc("fn_list_visible_users");
    expect(data).toBeNull();
    expect(error).not.toBeNull();
    // PostgREST surfaces Postgres SQLSTATE 42501 as code "42501" and the
    // message includes "permission denied". Be lenient on exact spelling
    // (PostgREST wraps the SQLSTATE in a JSON payload).
    const codeOrMessage = `${error?.code ?? ""} ${error?.message ?? ""}`.toLowerCase();
    expect(
      codeOrMessage.includes("42501") ||
        codeOrMessage.includes("permission denied")
    ).toBe(true);
  });

  it("A (super_admin) sees A, B, C, D when listing all", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await A.client.rpc("fn_list_visible_users");
    expect(error).toBeNull();
    const ids = new Set(((data ?? []) as VisibleRow[]).map((r) => r.user_id));
    expect(ids.has(A.userId)).toBe(true);
    expect(ids.has(B.userId)).toBe(true);
    expect(ids.has(C.userId)).toBe(true);
    expect(ids.has(D.userId)).toBe(true);
  });

  it("B (org_manager @ NFE) sees self + C; does NOT see A or D", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await B.client.rpc("fn_list_visible_users", {
      _target_user_ids: [A.userId, B.userId, C.userId, D.userId],
    });
    expect(error).toBeNull();
    const ids = new Set(((data ?? []) as VisibleRow[]).map((r) => r.user_id));
    expect(ids.has(B.userId)).toBe(true);
    expect(ids.has(C.userId)).toBe(true);
    expect(ids.has(A.userId)).toBe(false); // super_admin hidden
    expect(ids.has(D.userId)).toBe(false); // different org
  });

  it("D (org_manager @ OtherOrg) does NOT see B, C", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await D.client.rpc("fn_list_visible_users", {
      _target_user_ids: [A.userId, B.userId, C.userId, D.userId],
    });
    expect(error).toBeNull();
    const ids = new Set(((data ?? []) as VisibleRow[]).map((r) => r.user_id));
    expect(ids.has(D.userId)).toBe(true); // self
    expect(ids.has(B.userId)).toBe(false);
    expect(ids.has(C.userId)).toBe(false);
    expect(ids.has(A.userId)).toBe(false);
  });

  it("single-target lookup: org_manager B → D's id returns empty", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await B.client.rpc("fn_list_visible_users", {
      _target_user_ids: [D.userId],
    });
    expect(error).toBeNull();
    expect(((data ?? []) as VisibleRow[]).length).toBe(0);
  });

  it("single-target lookup: super_admin A → D's id returns one row", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await A.client.rpc("fn_list_visible_users", {
      _target_user_ids: [D.userId],
    });
    expect(error).toBeNull();
    const rows = (data ?? []) as VisibleRow[];
    expect(rows.length).toBe(1);
    expect(rows[0].user_id).toBe(D.userId);
  });

  it("batch lookup: B's [A, C, D] → only C surfaces (≤3 per visibility)", async () => {
    // Preserves the audit-log-fetch.ts use case: send a set of actor ids,
    // get back the subset the caller can see — RLS-hidden actors silently
    // drop out (callers render null for those).
    if (skipIfRequested()) return;
    const { data, error } = await B.client.rpc("fn_list_visible_users", {
      _target_user_ids: [A.userId, C.userId, D.userId],
    });
    expect(error).toBeNull();
    const ids = new Set(((data ?? []) as VisibleRow[]).map((r) => r.user_id));
    expect(ids.has(C.userId)).toBe(true);
    expect(ids.has(A.userId)).toBe(false);
    expect(ids.has(D.userId)).toBe(false);
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
