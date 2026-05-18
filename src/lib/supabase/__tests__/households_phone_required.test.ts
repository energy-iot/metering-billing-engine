/**
 * households_phone_required.test.ts (#155)
 *
 * Verifies the migration `00024_households_primary_phone_required.sql`:
 *   1. `households.primary_phone` is NOT NULL post-migration (asserted
 *      behaviorally — a NULL insert must raise 23502 not_null_violation).
 *   2. `fn_create_household_with_meter` raises `household_phone_required`
 *      when called with NULL or whitespace-only `p_primary_phone`.
 *
 * Prerequisites mirror the RLS suite — local Supabase running, SUPABASE_JWT_SECRET
 * set. Honors `SKIP_RLS_TESTS=1` for CI without Docker.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

// Minimal fixture so we have a microgrid to attach the NULL-insert assertion
// to. Cleaned up in afterAll.
const FIXTURE = {
  orgId: "dddddddd-dddd-4000-8000-000000000155",
  communityId: "dddddddd-dddd-4000-8001-000000000155",
  microgridId: "dddddddd-dddd-4000-8002-000000000155",
};

desc("00024_households_primary_phone_required.sql (#155)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();

    const svc = await serviceClient();
    await cleanupTestData({ orgIds: [FIXTURE.orgId], userEmails: [] });

    await svc.from("organizations").insert({
      id: FIXTURE.orgId,
      name: "Phone-required Test Org",
    });
    await svc.from("communities").insert({
      id: FIXTURE.communityId,
      org_id: FIXTURE.orgId,
      name: "Phone-required Comm",
    });
    await svc.from("microgrids").insert({
      id: FIXTURE.microgridId,
      community_id: FIXTURE.communityId,
      name: "Phone-required MG",
      currency: "UGX",
    });
  }, 30_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({ orgIds: [FIXTURE.orgId], userEmails: [] });
  }, 30_000);

  it("households.primary_phone is NOT NULL", async () => {
    // Behavioral assertion: try to INSERT a household with primary_phone=NULL
    // and expect 23502 not_null_violation.
    //
    // Previously this test queried information_schema.columns via PostgREST,
    // which newer Supabase CLI versions no longer expose (PGRST106). See #242.
    const svc = await serviceClient();
    const { error } = await svc.from("households").insert({
      id: randomUUID(),
      microgrid_id: FIXTURE.microgridId,
      display_name: "Should fail — null phone",
      primary_phone: null,
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23502");
  });

  it("fn_create_household_with_meter raises household_phone_required when phone is NULL", async () => {
    const svc = await serviceClient();
    const { error } = await svc.rpc("fn_create_household_with_meter", {
      p_microgrid_id: "00000000-0000-4000-8000-000000000001",
      p_display_name: "Phone-required test",
      p_device_id: "00000000-0000-4000-8000-000000000002",
      // Intentionally omit p_primary_phone → defaults to NULL
    });
    expect(error).toBeTruthy();
    expect(error?.message).toContain("household_phone_required");
  });

  it("fn_create_household_with_meter raises household_phone_required when phone is whitespace", async () => {
    const svc = await serviceClient();
    const { error } = await svc.rpc("fn_create_household_with_meter", {
      p_microgrid_id: "00000000-0000-4000-8000-000000000001",
      p_display_name: "Phone-required test",
      p_device_id: "00000000-0000-4000-8000-000000000002",
      p_primary_phone: "   ",
    });
    expect(error).toBeTruthy();
    expect(error?.message).toContain("household_phone_required");
  });
});
