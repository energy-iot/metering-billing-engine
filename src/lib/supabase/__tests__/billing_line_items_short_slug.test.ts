/**
 * billing_line_items_short_slug.test.ts (#223, migration
 * 00038_billing_line_items_short_slug.sql)
 *
 * Verifies the schema:
 *   1. `billing_line_items.short_slug` column exists and is nullable.
 *   2. CHECK constraint rejects out-of-range / out-of-alphabet values:
 *      - 5 chars → 23514 check_violation
 *      - 9 chars → 23514 check_violation
 *      - non-base62 char (hyphen) → 23514 check_violation
 *      - exactly 6 chars base62 → success
 *      - exactly 8 chars base62 → success
 *   3. Partial UNIQUE index allows multiple NULLs (Postgres default) but
 *      rejects duplicate non-NULLs with 23505.
 *
 * Honors SKIP_RLS_TESTS=1 for CI without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log(
    "[billing_line_items_short_slug] SKIP_RLS_TESTS=1 — skipping suite.",
  );
}

const FIXTURE = {
  orgId: "eeeeeeee-eeee-4000-8000-00000000023a",
  communityId: "eeeeeeee-eeee-4000-8001-00000000023a",
  microgridId: "eeeeeeee-eeee-4000-8002-00000000023a",
  householdId: "eeeeeeee-eeee-4000-8003-00000000023a",
  deviceId: "eeeeeeee-eeee-4000-8004-00000000023a",
  edgeId: "eeeeeeee-eeee-4000-8005-00000000023a",
  periodId: "eeeeeeee-eeee-4000-8006-00000000023a",
  // Two distinct line item ids — used for the multi-NULL and duplicate
  // assertions.
  lineItemA: "eeeeeeee-eeee-4000-8007-00000000023a",
  lineItemB: "eeeeeeee-eeee-4000-8008-00000000023a",
};

desc("00038_billing_line_items_short_slug.sql (#223)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();

    // Idempotent reset — clean any prior state for this fixture.
    await cleanupTestData({ orgIds: [FIXTURE.orgId], userEmails: [] });

    await svc
      .from("organizations")
      .insert({ id: FIXTURE.orgId, name: "Short-slug Org" });
    await svc.from("communities").insert({
      id: FIXTURE.communityId,
      org_id: FIXTURE.orgId,
      name: "Short-slug Community",
    });
    await svc.from("microgrids").insert({
      id: FIXTURE.microgridId,
      community_id: FIXTURE.communityId,
      name: "Short-slug MG",
      currency: "UGX",
    });
    await svc.from("edges").insert({
      id: FIXTURE.edgeId,
      microgrid_id: FIXTURE.microgridId,
      name: "Edge",
    });
    await svc.from("devices").insert({
      id: FIXTURE.deviceId,
      edge_id: FIXTURE.edgeId,
      device_type: "consumption_meter",
      name: "Meter",
    });
    await svc.from("households").insert({
      id: FIXTURE.householdId,
      microgrid_id: FIXTURE.microgridId,
      display_name: "Sam",
      primary_phone: "+256700000000",
    });
    await svc.from("billing_periods").insert({
      id: FIXTURE.periodId,
      microgrid_id: FIXTURE.microgridId,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
    });
    // Two line items for the duplicate / NULL tests.
    await svc.from("billing_line_items").insert({
      id: FIXTURE.lineItemA,
      billing_period_id: FIXTURE.periodId,
      household_id: FIXTURE.householdId,
      total_amount: 1000,
      tier_breakdown: [],
    });
    await svc.from("billing_line_items").insert({
      id: FIXTURE.lineItemB,
      billing_period_id: FIXTURE.periodId,
      household_id: FIXTURE.householdId,
      total_amount: 1000,
      tier_breakdown: [],
    });
  });

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({ orgIds: [FIXTURE.orgId], userEmails: [] });
  });

  it("column exists and is nullable", async () => {
    const svc = await serviceClient();
    const { data, error } = await svc
      .schema("information_schema" as never)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("columns" as any)
      .select("is_nullable, data_type")
      .eq("table_schema", "public")
      .eq("table_name", "billing_line_items")
      .eq("column_name", "short_slug")
      .single<{ is_nullable: string; data_type: string }>();
    expect(error).toBeNull();
    expect(data?.is_nullable).toBe("YES");
    expect(data?.data_type).toBe("text");
  });

  it("rejects 5-char short_slug (below CHECK lower bound) with 23514", async () => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("billing_line_items")
      .update({ short_slug: "12345" })
      .eq("id", FIXTURE.lineItemA);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
  });

  it("rejects 9-char short_slug (above CHECK upper bound) with 23514", async () => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("billing_line_items")
      .update({ short_slug: "123456789" })
      .eq("id", FIXTURE.lineItemA);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
  });

  it("rejects non-base62 character (hyphen) with 23514", async () => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("billing_line_items")
      .update({ short_slug: "abc-12" })
      .eq("id", FIXTURE.lineItemA);
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
  });

  it("accepts 6-char base62 short_slug", async () => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("billing_line_items")
      .update({ short_slug: "ValidA" })
      .eq("id", FIXTURE.lineItemA);
    expect(error).toBeNull();
    // Reset for subsequent tests.
    await svc
      .from("billing_line_items")
      .update({ short_slug: null })
      .eq("id", FIXTURE.lineItemA);
  });

  it("accepts 8-char base62 short_slug", async () => {
    const svc = await serviceClient();
    const { error } = await svc
      .from("billing_line_items")
      .update({ short_slug: "ValidA12" })
      .eq("id", FIXTURE.lineItemA);
    expect(error).toBeNull();
    // Reset for subsequent tests.
    await svc
      .from("billing_line_items")
      .update({ short_slug: null })
      .eq("id", FIXTURE.lineItemA);
  });

  it("partial UNIQUE index rejects duplicate non-NULL short_slug with 23505", async () => {
    const svc = await serviceClient();
    // First insert — claim a slug on A.
    let { error } = await svc
      .from("billing_line_items")
      .update({ short_slug: "DupeSL" })
      .eq("id", FIXTURE.lineItemA);
    expect(error).toBeNull();

    // Second insert — try to claim the SAME slug on B. Must fail with 23505.
    ({ error } = await svc
      .from("billing_line_items")
      .update({ short_slug: "DupeSL" })
      .eq("id", FIXTURE.lineItemB));
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505");

    // Cleanup — release the slug on A so subsequent runs don't trip.
    await svc
      .from("billing_line_items")
      .update({ short_slug: null })
      .eq("id", FIXTURE.lineItemA);
  });

  it("partial UNIQUE index allows multiple NULLs", async () => {
    const svc = await serviceClient();
    // Both A and B start NULL (the migration sets nothing, and the prior
    // duplicate test resets A). Confirm we can keep both NULL without error.
    const { data, error } = await svc
      .from("billing_line_items")
      .select("id, short_slug")
      .in("id", [FIXTURE.lineItemA, FIXTURE.lineItemB]);
    expect(error).toBeNull();
    expect(data).toHaveLength(2);
    // Both NULL — the partial UNIQUE index does NOT fire on NULLs.
    for (const row of data ?? []) {
      expect(row.short_slug).toBeNull();
    }
  });
});
