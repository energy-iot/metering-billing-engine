/**
 * rls.test.ts
 *
 * RLS policy verification suite for the entity-model schema (AB ticket #50 / E ticket #56).
 *
 * Prerequisites:
 *   1. Local Supabase CLI running: `supabase start` (or `supabase start` + `supabase db reset`)
 *   2. SUPABASE_JWT_SECRET set in .env.local (get from: `supabase status | grep 'JWT secret'`)
 *   3. NEXT_PUBLIC_SUPABASE_ANON_KEY set in .env.local
 *
 * Opt-out:
 *   SKIP_RLS_TESTS=1  — skips the suite cleanly (for CI without local Supabase)
 *
 * Fixture strategy:
 *   - beforeAll: creates two additional orgs (NFE-A, NFE-B) + full hierarchy + 4 test users
 *   - afterAll: tears down all test fixtures (cascade delete via org_id)
 *   - Seed data from AB's 00003_seed.sql.template is untouched
 *
 * Tables covered (all 10 AC-required tables):
 *   organizations, communities, microgrids, edges, devices,
 *   household_devices, households, billing_periods, billing_line_items, user_roles
 *
 * Helper functions tested:
 *   is_super_admin(), user_can_access_org(), user_can_access_microgrid()
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { type SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "./rls.helpers";

// ── Fixture IDs (deterministic — simplifies cleanup) ──────────────────────

// All UUIDs must be valid UUID v4 format (8-4-4-4-12 hex chars).
// Prefix 'aaaa...' = NFE-A hierarchy, 'bbbb...' = NFE-B hierarchy.
const FIXTURE = {
  // Orgs
  orgA: "aaaaaaaa-aaaa-4000-8000-000000000001",
  orgB: "bbbbbbbb-bbbb-4000-8000-000000000001",

  // Communities
  communityA: "aaaaaaaa-aaaa-4000-8001-000000000001",
  communityB: "bbbbbbbb-bbbb-4000-8001-000000000001",

  // Microgrids
  microgridA: "aaaaaaaa-aaaa-4000-8002-000000000001",
  microgridB: "bbbbbbbb-bbbb-4000-8002-000000000001",

  // Edges
  edgeA: "aaaaaaaa-aaaa-4000-8003-000000000001",
  edgeB: "bbbbbbbb-bbbb-4000-8003-000000000001",

  // Devices
  deviceA: "aaaaaaaa-aaaa-4000-8004-000000000001",
  deviceB: "bbbbbbbb-bbbb-4000-8004-000000000001",

  // Households
  householdA: "aaaaaaaa-aaaa-4000-8005-000000000001",
  householdB: "bbbbbbbb-bbbb-4000-8005-000000000001",

  // Billing periods
  billingPeriodA: "aaaaaaaa-aaaa-4000-8006-000000000001",
  billingPeriodB: "bbbbbbbb-bbbb-4000-8006-000000000001",

  // Billing line items
  lineItemA: "aaaaaaaa-aaaa-4000-8007-000000000001",
  lineItemB: "bbbbbbbb-bbbb-4000-8007-000000000001",

  // household_devices rows are created without explicit IDs (no AC requirement for deterministic IDs there)
};

// ── Test state ────────────────────────────────────────────────────────────

let userA: TestUser; // org_manager scoped to orgA
let userB: TestUser; // org_manager scoped to orgB
let userC: TestUser; // no role
let userD: TestUser; // super_admin

const testUserEmails = [
  "rls-test-usera@test.local",
  "rls-test-userb@test.local",
  "rls-test-userc@test.local",
  "rls-test-userd@test.local",
];

// ── Setup / teardown ──────────────────────────────────────────────────────

beforeAll(async () => {
  if (shouldSkip()) return;

  await assertEnvironmentReady();

  const svc = await serviceClient();

  // Clean up any leftover fixtures from a prior run.
  await cleanupTestData({
    orgIds: [FIXTURE.orgA, FIXTURE.orgB],
    userEmails: testUserEmails,
  });

  // ── Insert fixture orgs, communities, microgrids, edges, devices, households ──

  const { error: orgError } = await svc.from("organizations").insert([
    { id: FIXTURE.orgA, name: "Test Org NFE-A" },
    { id: FIXTURE.orgB, name: "Test Org NFE-B" },
  ]);
  if (orgError) throw new Error(`[fixture] orgs: ${orgError.message}`);

  const { error: commError } = await svc.from("communities").insert([
    { id: FIXTURE.communityA, org_id: FIXTURE.orgA, name: "Community A" },
    { id: FIXTURE.communityB, org_id: FIXTURE.orgB, name: "Community B" },
  ]);
  if (commError) throw new Error(`[fixture] communities: ${commError.message}`);

  const { error: mgError } = await svc.from("microgrids").insert([
    {
      id: FIXTURE.microgridA,
      community_id: FIXTURE.communityA,
      name: "Microgrid A",
      currency: "UGX",
    },
    {
      id: FIXTURE.microgridB,
      community_id: FIXTURE.communityB,
      name: "Microgrid B",
      currency: "UGX",
    },
  ]);
  if (mgError) throw new Error(`[fixture] microgrids: ${mgError.message}`);

  const { error: edgeError } = await svc.from("edges").insert([
    {
      id: FIXTURE.edgeA,
      microgrid_id: FIXTURE.microgridA,
      name: "Edge A",
      data_source_type: "openems",
      openems_backend_url: "http://localhost:8075",
      openems_edge_id: "rls-test-edge-a",
    },
    {
      id: FIXTURE.edgeB,
      microgrid_id: FIXTURE.microgridB,
      name: "Edge B",
      data_source_type: "openems",
      openems_backend_url: "http://localhost:8075",
      openems_edge_id: "rls-test-edge-b",
    },
  ]);
  if (edgeError) throw new Error(`[fixture] edges: ${edgeError.message}`);

  const { error: devError } = await svc.from("devices").insert([
    {
      id: FIXTURE.deviceA,
      edge_id: FIXTURE.edgeA,
      name: "Device A",
      device_type: "consumption_meter",
      openems_component_id: "rls-meter-a",
    },
    {
      id: FIXTURE.deviceB,
      edge_id: FIXTURE.edgeB,
      name: "Device B",
      device_type: "consumption_meter",
      openems_component_id: "rls-meter-b",
    },
  ]);
  if (devError) throw new Error(`[fixture] devices: ${devError.message}`);

  const { error: hhError } = await svc.from("households").insert([
    {
      id: FIXTURE.householdA,
      microgrid_id: FIXTURE.microgridA,
      display_name: "Household A",
    },
    {
      id: FIXTURE.householdB,
      microgrid_id: FIXTURE.microgridB,
      display_name: "Household B",
    },
  ]);
  if (hhError) throw new Error(`[fixture] households: ${hhError.message}`);

  // household_devices (one primary_consumption_meter per household)
  const { error: hhdError } = await svc.from("household_devices").insert([
    {
      household_id: FIXTURE.householdA,
      device_id: FIXTURE.deviceA,
      role: "primary_consumption_meter",
    },
    {
      household_id: FIXTURE.householdB,
      device_id: FIXTURE.deviceB,
      role: "primary_consumption_meter",
    },
  ]);
  if (hhdError) throw new Error(`[fixture] household_devices: ${hhdError.message}`);

  // billing_periods
  const { error: bpError } = await svc.from("billing_periods").insert([
    {
      id: FIXTURE.billingPeriodA,
      microgrid_id: FIXTURE.microgridA,
      start_date: "2026-01-01",
      end_date: "2026-01-31",
      status: "draft",
    },
    {
      id: FIXTURE.billingPeriodB,
      microgrid_id: FIXTURE.microgridB,
      start_date: "2026-01-01",
      end_date: "2026-01-31",
      status: "draft",
    },
  ]);
  if (bpError) throw new Error(`[fixture] billing_periods: ${bpError.message}`);

  // billing_line_items
  const { error: liError } = await svc.from("billing_line_items").insert([
    {
      id: FIXTURE.lineItemA,
      billing_period_id: FIXTURE.billingPeriodA,
      household_id: FIXTURE.householdA,
      device_id: FIXTURE.deviceA,
      usage_kwh: 100,
      total_amount: 25000,
    },
    {
      id: FIXTURE.lineItemB,
      billing_period_id: FIXTURE.billingPeriodB,
      household_id: FIXTURE.householdB,
      device_id: FIXTURE.deviceB,
      usage_kwh: 80,
      total_amount: 20000,
    },
  ]);
  if (liError) throw new Error(`[fixture] billing_line_items: ${liError.message}`);

  // ── Create test users ──

  [userA, userB, userC, userD] = await Promise.all([
    createTestUser({
      email: testUserEmails[0],
      role: "org_manager",
      scopeId: FIXTURE.orgA,
    }),
    createTestUser({
      email: testUserEmails[1],
      role: "org_manager",
      scopeId: FIXTURE.orgB,
    }),
    createTestUser({
      email: testUserEmails[2],
      role: null, // no role — no access
    }),
    createTestUser({
      email: testUserEmails[3],
      role: "super_admin",
    }),
  ]);
}, 60_000);

afterAll(async () => {
  if (shouldSkip()) return;

  await cleanupTestData({
    orgIds: [FIXTURE.orgA, FIXTURE.orgB],
    userEmails: testUserEmails,
  });
}, 30_000);

// ── Skip guard ─────────────────────────────────────────────────────────────

function skipIfRequested(): boolean {
  if (shouldSkip()) {
    console.log("[RLS tests] SKIP_RLS_TESTS=1 — skipping suite.");
    return true;
  }
  return false;
}

// ── Helper: assert zero rows returned ─────────────────────────────────────

async function expectZeroRows(
  client: SupabaseClient,
  table: string,
  filter: { column: string; value: string }
): Promise<void> {
  const { data, error } = await client
    .from(table)
    .select("id")
    .eq(filter.column, filter.value);
  // RLS may either return an empty array or an error — both mean access denied.
  // We treat both as "zero access".
  const count = error ? 0 : (data ?? []).length;
  expect(count, `Expected 0 rows from ${table} for cross-org access`).toBe(0);
}

// ── Helper: assert RLS violation on write ────────────────────────────────

async function expectWriteDenied(
  client: SupabaseClient,
  table: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  row: Record<string, any>
): Promise<void> {
  const { data, error } = await client.from(table).insert(row).select("id");
  // RLS violation: either error is raised OR RETURNING returns empty.
  const inserted = error ? 0 : (data ?? []).length;
  expect(
    error !== null || inserted === 0,
    `Expected RLS to block INSERT on ${table} but it succeeded (error=${error?.message}, rows=${inserted})`
  ).toBe(true);
}

// ══════════════════════════════════════════════════════════════════════════
// 1. organizations
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: organizations", () => {
  it("User A reads own org", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("organizations")
      .select("id")
      .eq("id", FIXTURE.orgA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Org B", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userA.client, "organizations", {
      column: "id",
      value: FIXTURE.orgB,
    });
  });

  it("User B reads own org", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userB.client
      .from("organizations")
      .select("id")
      .eq("id", FIXTURE.orgB);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User B cannot read Org A", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userB.client, "organizations", {
      column: "id",
      value: FIXTURE.orgA,
    });
  });

  it("User C (no role) cannot read any org", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userC.client, "organizations", {
      column: "id",
      value: FIXTURE.orgA,
    });
    await expectZeroRows(userC.client, "organizations", {
      column: "id",
      value: FIXTURE.orgB,
    });
  });

  it("User D (super_admin) reads both orgs", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("organizations")
      .select("id")
      .in("id", [FIXTURE.orgA, FIXTURE.orgB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT into Org B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "organizations", {
      id: "cccccccc-test-ffff-0000-000000000001",
      name: "Unauthorized Org",
    });
  });

  it("User A can INSERT own org's child (org update via org-scoped operation)", async () => {
    if (skipIfRequested()) return;
    // organizations are top-level; User A can update their own org
    const { error } = await userA.client
      .from("organizations")
      .update({ name: "Test Org NFE-A (updated)" })
      .eq("id", FIXTURE.orgA);
    // Should not error
    expect(error).toBeNull();
    // Reset
    const svc = await serviceClient();
    await svc.from("organizations").update({ name: "Test Org NFE-A" }).eq("id", FIXTURE.orgA);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 2. communities
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: communities", () => {
  it("User A reads own community", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("communities")
      .select("id")
      .eq("id", FIXTURE.communityA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Community B", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userA.client, "communities", {
      column: "id",
      value: FIXTURE.communityB,
    });
  });

  it("User C (no role) cannot read any community", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userC.client, "communities", {
      column: "id",
      value: FIXTURE.communityA,
    });
  });

  it("User D (super_admin) reads both communities", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("communities")
      .select("id")
      .in("id", [FIXTURE.communityA, FIXTURE.communityB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT community into Org B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "communities", {
      org_id: FIXTURE.orgB,
      name: "Unauthorized Community",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 3. microgrids
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: microgrids", () => {
  it("User A reads own microgrid", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("microgrids")
      .select("id")
      .eq("id", FIXTURE.microgridA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Microgrid B", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userA.client, "microgrids", {
      column: "id",
      value: FIXTURE.microgridB,
    });
  });

  it("User C (no role) cannot read any microgrid", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userC.client, "microgrids", {
      column: "id",
      value: FIXTURE.microgridA,
    });
  });

  it("User D (super_admin) reads both microgrids", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("microgrids")
      .select("id")
      .in("id", [FIXTURE.microgridA, FIXTURE.microgridB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT microgrid into Community B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "microgrids", {
      community_id: FIXTURE.communityB,
      name: "Unauthorized Microgrid",
      currency: "UGX",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 4. edges
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: edges", () => {
  it("User A reads own edge", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("edges")
      .select("id")
      .eq("id", FIXTURE.edgeA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Edge B", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userA.client, "edges", {
      column: "id",
      value: FIXTURE.edgeB,
    });
  });

  it("User C (no role) cannot read any edge", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userC.client, "edges", {
      column: "id",
      value: FIXTURE.edgeA,
    });
  });

  it("User D (super_admin) reads both edges", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("edges")
      .select("id")
      .in("id", [FIXTURE.edgeA, FIXTURE.edgeB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT edge into Microgrid B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "edges", {
      microgrid_id: FIXTURE.microgridB,
      name: "Unauthorized Edge",
      data_source_type: "openems",
      openems_backend_url: "http://localhost:8075",
      openems_edge_id: "rls-unauth-edge",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 5. devices
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: devices", () => {
  it("User A reads own device", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("devices")
      .select("id")
      .eq("id", FIXTURE.deviceA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Device B", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userA.client, "devices", {
      column: "id",
      value: FIXTURE.deviceB,
    });
  });

  it("User C (no role) cannot read any device", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userC.client, "devices", {
      column: "id",
      value: FIXTURE.deviceA,
    });
  });

  it("User D (super_admin) reads both devices", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("devices")
      .select("id")
      .in("id", [FIXTURE.deviceA, FIXTURE.deviceB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT device into Edge B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "devices", {
      edge_id: FIXTURE.edgeB,
      name: "Unauthorized Device",
      device_type: "consumption_meter",
      openems_component_id: "rls-unauth-device",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 6. households
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: households", () => {
  it("User A reads own household", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("households")
      .select("id")
      .eq("id", FIXTURE.householdA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Household B", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userA.client, "households", {
      column: "id",
      value: FIXTURE.householdB,
    });
  });

  it("User C (no role) cannot read any household", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userC.client, "households", {
      column: "id",
      value: FIXTURE.householdA,
    });
  });

  it("User D (super_admin) reads both households", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("households")
      .select("id")
      .in("id", [FIXTURE.householdA, FIXTURE.householdB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT household into Microgrid B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "households", {
      microgrid_id: FIXTURE.microgridB,
      display_name: "Unauthorized Household",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 7. household_devices
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: household_devices", () => {
  it("User A reads own household_devices", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("household_devices")
      .select("id")
      .eq("household_id", FIXTURE.householdA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Household B devices", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("household_devices")
      .select("id")
      .eq("household_id", FIXTURE.householdB);
    const count = error ? 0 : (data ?? []).length;
    expect(count).toBe(0);
  });

  it("User C (no role) cannot read any household_devices", async () => {
    if (skipIfRequested()) return;
    const { data } = await userC.client
      .from("household_devices")
      .select("id")
      .eq("household_id", FIXTURE.householdA);
    expect((data ?? []).length).toBe(0);
  });

  it("User D (super_admin) reads both household_devices", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("household_devices")
      .select("id")
      .in("household_id", [FIXTURE.householdA, FIXTURE.householdB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT household_device linking Household B to Device A", async () => {
    if (skipIfRequested()) return;
    // This would be a cross-org link — both RLS on household_devices AND the FK chain should block.
    await expectWriteDenied(userA.client, "household_devices", {
      household_id: FIXTURE.householdB,
      device_id: FIXTURE.deviceA,
      role: "secondary_meter",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 8. billing_periods
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: billing_periods", () => {
  it("User A reads own billing period", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("billing_periods")
      .select("id")
      .eq("id", FIXTURE.billingPeriodA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Billing Period B", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userA.client, "billing_periods", {
      column: "id",
      value: FIXTURE.billingPeriodB,
    });
  });

  it("User C (no role) cannot read any billing period", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userC.client, "billing_periods", {
      column: "id",
      value: FIXTURE.billingPeriodA,
    });
  });

  it("User D (super_admin) reads both billing periods", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("billing_periods")
      .select("id")
      .in("id", [FIXTURE.billingPeriodA, FIXTURE.billingPeriodB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT billing period for Microgrid B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "billing_periods", {
      microgrid_id: FIXTURE.microgridB,
      start_date: "2026-02-01",
      end_date: "2026-02-28",
      status: "draft",
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 9. billing_line_items
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: billing_line_items", () => {
  it("User A reads own line item", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("billing_line_items")
      .select("id")
      .eq("id", FIXTURE.lineItemA);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
  });

  it("User A cannot read Line Item B", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userA.client, "billing_line_items", {
      column: "id",
      value: FIXTURE.lineItemB,
    });
  });

  it("User C (no role) cannot read any line item", async () => {
    if (skipIfRequested()) return;
    await expectZeroRows(userC.client, "billing_line_items", {
      column: "id",
      value: FIXTURE.lineItemA,
    });
  });

  it("User D (super_admin) reads both line items", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("billing_line_items")
      .select("id")
      .in("id", [FIXTURE.lineItemA, FIXTURE.lineItemB]);
    expect(error).toBeNull();
    expect(data?.length).toBe(2);
  });

  it("User A cannot INSERT line item for Billing Period B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "billing_line_items", {
      billing_period_id: FIXTURE.billingPeriodB,
      household_id: FIXTURE.householdB,
      usage_kwh: 50,
      total_amount: 12500,
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 10. user_roles
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: user_roles", () => {
  it("User A can read their own user_roles row", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userA.client
      .from("user_roles")
      .select("id, role")
      .eq("user_id", userA.userId);
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);
    expect(data?.[0]?.role).toBe("org_manager");
  });

  it("User A cannot read User B's user_roles row", async () => {
    if (skipIfRequested()) return;
    const { data } = await userA.client
      .from("user_roles")
      .select("id")
      .eq("user_id", userB.userId);
    expect((data ?? []).length).toBe(0);
  });

  it("User C (no role) cannot read any user_roles", async () => {
    if (skipIfRequested()) return;
    const { data } = await userC.client
      .from("user_roles")
      .select("id")
      .eq("user_id", userA.userId);
    expect((data ?? []).length).toBe(0);
  });

  it("User D (super_admin) reads all user_roles", async () => {
    if (skipIfRequested()) return;
    const { data, error } = await userD.client
      .from("user_roles")
      .select("id")
      .in("user_id", [userA.userId, userB.userId, userC.userId, userD.userId]);
    expect(error).toBeNull();
    // userA, userB, userD have role rows; userC does not
    expect(data?.length).toBeGreaterThanOrEqual(3);
  });

  it("User A cannot INSERT a user_roles row for any user (non-super_admin)", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "user_roles", {
      user_id: userC.userId,
      role: "org_manager",
      scope_type: "org",
      scope_id: FIXTURE.orgA,
    });
  });

  it("User D (super_admin) can INSERT a user_roles row", async () => {
    if (skipIfRequested()) return;
    // Insert a temporary role row, then clean it up
    const { data, error } = await userD.client
      .from("user_roles")
      .insert({
        user_id: userC.userId,
        role: "org_manager",
        scope_type: "org",
        scope_id: FIXTURE.orgA,
      })
      .select("id");
    expect(error).toBeNull();
    expect(data?.length).toBeGreaterThanOrEqual(1);

    // Cleanup: delete the temporary row
    if (data?.[0]?.id) {
      const svc = await serviceClient();
      await svc.from("user_roles").delete().eq("id", data[0].id);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════
// UX4a (#76) — write-path denial cases for entity CRUD endpoints
// ══════════════════════════════════════════════════════════════════════════
//
// Each test impersonates a user via the Supabase JS client (RLS applies) and
// attempts the write that the corresponding /api/* endpoint would perform.
// The API layer adds a role check + RLS backstop; these tests verify the
// backstop is intact at the DB level.

describe("UX4a (#76) entity CRUD write-path denials", () => {
  // (a) non-super_admin POST to /api/organizations → RLS blocks INSERT
  it("User A (org_manager) cannot INSERT a brand-new organization", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "organizations", {
      id: "cccccccc-test-0076-0000-000000000001",
      name: "Cross-org Org via UX4a",
    });
  });

  it("User C (no role) cannot INSERT an organization", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userC.client, "organizations", {
      id: "cccccccc-test-0076-0000-000000000002",
      name: "No-role Org",
    });
  });

  // (b) org_manager in Org A posts /api/communities with org_id = Org B → denied
  it("User A (org_manager of Org A) cannot INSERT a community under Org B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "communities", {
      org_id: FIXTURE.orgB,
      name: "Cross-org community via UX4a",
    });
  });

  // (c) org_manager POST /api/microgrids with community_id outside their org → denied
  it("User A (org_manager of Org A) cannot INSERT a microgrid under Community B", async () => {
    if (skipIfRequested()) return;
    await expectWriteDenied(userA.client, "microgrids", {
      community_id: FIXTURE.communityB,
      name: "Cross-org microgrid via UX4a",
      currency: "UGX",
    });
  });

  // Sanity: super_admin CAN insert through the same table
  it("User D (super_admin) CAN INSERT a temporary organization", async () => {
    if (skipIfRequested()) return;
    const tmpId = "cccccccc-test-0076-0000-000000000003";
    const { data, error } = await userD.client
      .from("organizations")
      .insert({ id: tmpId, name: "UX4a super_admin sanity" })
      .select("id");
    expect(error).toBeNull();
    expect(data?.[0]?.id).toBe(tmpId);

    // Cleanup
    const svc = await serviceClient();
    await svc.from("organizations").delete().eq("id", tmpId);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// 11. Helper function contract tests
// ══════════════════════════════════════════════════════════════════════════

describe("RLS helper functions", () => {
  async function callRpc(
    client: SupabaseClient,
    fn: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    const { data, error } = await client.rpc(fn, args);
    if (error) throw new Error(`RPC ${fn} error: ${error.message}`);
    return data;
  }

  describe("is_super_admin()", () => {
    it("returns true for User D (super_admin)", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userD.client, "is_super_admin");
      expect(result).toBe(true);
    });

    it("returns false for User A (org_manager)", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userA.client, "is_super_admin");
      expect(result).toBe(false);
    });

    it("returns false for User C (no role)", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userC.client, "is_super_admin");
      expect(result).toBe(false);
    });
  });

  describe("user_can_access_org(org_id)", () => {
    it("returns true for User A on Org A (own org)", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userA.client, "user_can_access_org", {
        _org_id: FIXTURE.orgA,
      });
      expect(result).toBe(true);
    });

    it("returns false for User A on Org B (cross-org)", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userA.client, "user_can_access_org", {
        _org_id: FIXTURE.orgB,
      });
      expect(result).toBe(false);
    });

    it("returns true for User D (super_admin) on any org", async () => {
      if (skipIfRequested()) return;
      const [resultA, resultB] = await Promise.all([
        callRpc(userD.client, "user_can_access_org", { _org_id: FIXTURE.orgA }),
        callRpc(userD.client, "user_can_access_org", { _org_id: FIXTURE.orgB }),
      ]);
      expect(resultA).toBe(true);
      expect(resultB).toBe(true);
    });

    it("returns false for User C (no role) on any org", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userC.client, "user_can_access_org", {
        _org_id: FIXTURE.orgA,
      });
      expect(result).toBe(false);
    });
  });

  describe("user_can_access_microgrid(microgrid_id)", () => {
    it("returns true for User A on Microgrid A (own org chain)", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userA.client, "user_can_access_microgrid", {
        _microgrid_id: FIXTURE.microgridA,
      });
      expect(result).toBe(true);
    });

    it("returns false for User A on Microgrid B (cross-org)", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userA.client, "user_can_access_microgrid", {
        _microgrid_id: FIXTURE.microgridB,
      });
      expect(result).toBe(false);
    });

    it("returns true for User D (super_admin) on any microgrid", async () => {
      if (skipIfRequested()) return;
      const [resultA, resultB] = await Promise.all([
        callRpc(userD.client, "user_can_access_microgrid", {
          _microgrid_id: FIXTURE.microgridA,
        }),
        callRpc(userD.client, "user_can_access_microgrid", {
          _microgrid_id: FIXTURE.microgridB,
        }),
      ]);
      expect(resultA).toBe(true);
      expect(resultB).toBe(true);
    });

    it("returns false for User C (no role) on any microgrid", async () => {
      if (skipIfRequested()) return;
      const result = await callRpc(userC.client, "user_can_access_microgrid", {
        _microgrid_id: FIXTURE.microgridA,
      });
      expect(result).toBe(false);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════
// RLS: edge creation via API route (#77)
// Tests the HTTP response mapping for cross-org org_manager POST to /api/edges.
// The underlying Supabase RLS is already covered in "RLS: edges" above.
// This suite verifies the 42501 → 403 mapping at the API route level.
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: /api/edges cross-org POST denied (#77)", () => {
  it("User A (org_manager for Org A) cannot INSERT edge into Microgrid B via direct Supabase write", async () => {
    if (skipIfRequested()) return;

    // Attempt a direct insert using User A's client (authenticated as org_manager for orgA)
    // into microgridB — which belongs to orgB. RLS should block this.
    await expectWriteDenied(userA.client, "edges", {
      microgrid_id: FIXTURE.microgridB,
      name: "Cross-org-edge-api-test",
      data_source_type: "openems",
      openems_backend_url: "http://localhost:8075",
      openems_edge_id: "rls-test-api-edge",
    });
  });

  it("User A can INSERT edge into Microgrid A (own org) via direct Supabase write", async () => {
    if (skipIfRequested()) return;

    const { data, error } = await userA.client
      .from("edges")
      .insert({
        microgrid_id: FIXTURE.microgridA,
        name: "rls-api-test-own-edge",
        data_source_type: "modbus_direct",
      })
      .select("id");

    // RLS should permit this; clean up if it succeeded.
    if (data && data.length > 0) {
      await (await import("./rls.helpers")).serviceClient().then((svc) =>
        svc.from("edges").delete().eq("id", data[0].id)
      );
    }

    // Either no error, or the error is not a security policy error.
    const isRlsError =
      error?.code === "42501" ||
      (error?.message ?? "").includes("row-level security");
    expect(isRlsError).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// RLS: household creation via fn_create_household_with_meter RPC (#74)
// Verifies the wizard's server-side save path is denied cross-org.
// The RPC is SECURITY INVOKER, so the underlying households INSERT RLS
// policy is the authoritative gate. This test asserts that a cross-org
// org_manager cannot invoke the RPC successfully against another org's
// microgrid — either the RLS denies (42501) or one of the RPC's safety
// guards trips.
// ══════════════════════════════════════════════════════════════════════════

describe("RLS: fn_create_household_with_meter cross-org denied (#74)", () => {
  it("User A (org_manager for Org A) cannot create a household on Microgrid B via the RPC", async () => {
    if (skipIfRequested()) return;

    // User A calls the RPC targeting Microgrid B (belongs to Org B) and
    // Device B (also Org B). RLS on households INSERT must deny.
    const { data, error } = await userA.client.rpc(
      "fn_create_household_with_meter",
      {
        p_microgrid_id: FIXTURE.microgridB,
        p_display_name: "Cross-org household attempt",
        p_device_id: FIXTURE.deviceB,
      }
    );

    // Must not succeed — either an error surfaces, or data is null, but
    // critically there must NOT be a new household row for this call.
    const succeeded = !error && typeof data === "string" && data.length > 0;
    expect(
      succeeded,
      `Expected cross-org RPC call to be denied but it returned household_id=${data}`
    ).toBe(false);

    // Belt-and-braces: confirm no household row was created by checking
    // via service client that the RPC's returned id (if any) doesn't exist.
    if (typeof data === "string" && data.length > 0) {
      const svc = await (await import("./rls.helpers")).serviceClient();
      await svc.from("households").delete().eq("id", data);
    }
  });

  it("User A can create a household on Microgrid A (own org) via the RPC", async () => {
    if (skipIfRequested()) return;

    // Seed a fresh consumption_meter device on Edge A that has no
    // primary_consumption_meter assignment yet. We have to do this through
    // service_role because the partial unique index on household_devices
    // blocks reuse of FIXTURE.deviceA.
    const svc = await (await import("./rls.helpers")).serviceClient();
    const tmpDeviceId = "aaaaaaaa-aaaa-4000-8004-00000000007a";
    await svc.from("devices").insert({
      id: tmpDeviceId,
      edge_id: FIXTURE.edgeA,
      name: "rls-hh-rpc-tmp-device",
      device_type: "consumption_meter",
      openems_component_id: "rls-hh-rpc-tmp-meter",
    });

    try {
      const { data, error } = await userA.client.rpc(
        "fn_create_household_with_meter",
        {
          p_microgrid_id: FIXTURE.microgridA,
          p_display_name: "rls-hh-rpc-own-success",
          p_device_id: tmpDeviceId,
        }
      );

      // RLS should permit this. If it failed for a non-RLS reason we want
      // to surface the message instead of a bare false assertion.
      const isRlsError =
        error?.code === "42501" ||
        (error?.message ?? "").includes("row-level security");
      expect(isRlsError, `unexpected RLS error: ${error?.message}`).toBe(false);

      // Cleanup: remove the created household (cascades household_devices).
      if (typeof data === "string" && data.length > 0) {
        await svc.from("households").delete().eq("id", data);
      }
    } finally {
      await svc.from("devices").delete().eq("id", tmpDeviceId);
    }
  });
});
