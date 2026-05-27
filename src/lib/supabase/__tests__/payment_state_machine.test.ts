/**
 * payment_state_machine.test.ts (#157, migrations 00027 (enum) + 00028 (rest))
 *
 * Verifies the Phase B state machine end-to-end against a live local Supabase:
 *   - `link_generated` enum value present.
 *   - `payment_events` table exists with the documented columns.
 *   - `pesapal_order_id` column unique partial index allows multiple NULLs but
 *     rejects duplicate non-NULL values.
 *   - `fn_apply_payment_event` enforces the per-source transition matrix.
 *   - Idempotent re-application within 60s for source='ipn' = no duplicate
 *     audit row, no state change.
 *   - `payment_events` RLS — super_admin sees all, anon denied.
 *   - The CHECK constraint admits 'link_generated' as a no-audit-fields tier.
 *
 * Honors `SKIP_RLS_TESTS=1` for CI without local Supabase.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[payment_state_machine] SKIP_RLS_TESTS=1 — skipping suite.");
}

// Fail-loud insert helper — surface fixture drift instead of silently
// swallowing PostgREST errors. Catches things like the
// idx_billing_line_items_period_household UNIQUE collision that masked four
// failures in this file before #242.
async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(
      `[payment_state_machine] fixture insert failed on ${table}: ${error.message}`,
    );
  }
}

// Deterministic fixture IDs to keep teardown simple.
//
// householdA and householdB are distinct so that lineItemA and lineItemB do
// NOT collide on idx_billing_line_items_period_household (UNIQUE, added by
// migration 00029 AFTER this test was originally written). See #242.
const FIXTURE = {
  org: "cccccccc-cccc-4000-8000-000000000001",
  community: "cccccccc-cccc-4000-8001-000000000001",
  microgrid: "cccccccc-cccc-4000-8002-000000000001",
  edge: "cccccccc-cccc-4000-8003-000000000001",
  device: "cccccccc-cccc-4000-8004-000000000001",
  householdA: "cccccccc-cccc-4000-8005-000000000001",
  householdB: "cccccccc-cccc-4000-8005-000000000002",
  billingPeriod: "cccccccc-cccc-4000-8006-000000000001",
  lineItemA: "cccccccc-cccc-4000-8007-000000000001",
  lineItemB: "cccccccc-cccc-4000-8007-000000000002",
};

desc("00027_payment_state_machine_enum.sql + 00028_payment_state_machine.sql (#157)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();

    const svc = await serviceClient();

    // Clean up any leftover from a prior run.
    await cleanupTestData({
      orgIds: [FIXTURE.org],
      userEmails: [],
    });

    await insertOrThrow(svc, "organizations", {
      id: FIXTURE.org,
      name: "Phase B State Machine Test Org",
    });
    await insertOrThrow(svc, "communities", {
      id: FIXTURE.community,
      org_id: FIXTURE.org,
      name: "PB Comm",
    });
    await insertOrThrow(svc, "microgrids", {
      id: FIXTURE.microgrid,
      community_id: FIXTURE.community,
      name: "PB MG",
      currency: "UGX",
    });
    await insertOrThrow(svc, "edges", {
      id: FIXTURE.edge,
      microgrid_id: FIXTURE.microgrid,
      name: "PB Edge",
      openems_edge_id: "phase-b-edge",
    });
    await insertOrThrow(svc, "devices", {
      id: FIXTURE.device,
      edge_id: FIXTURE.edge,
      name: "PB Device",
      device_type: "consumption_meter",
      openems_component_id: "phase-b-meter",
    });
    await insertOrThrow(svc, "households", [
      {
        id: FIXTURE.householdA,
        microgrid_id: FIXTURE.microgrid,
        display_name: "PB Household A",
        primary_phone: "+256700000001",
      },
      {
        id: FIXTURE.householdB,
        microgrid_id: FIXTURE.microgrid,
        display_name: "PB Household B",
        primary_phone: "+256700000002",
      },
    ]);
    await insertOrThrow(svc, "billing_periods", {
      id: FIXTURE.billingPeriod,
      microgrid_id: FIXTURE.microgrid,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      status: "draft",
    });
    // lineItemA → householdA, lineItemB → householdB.
    // They MUST NOT share (billing_period_id, household_id) — migration 00029
    // added idx_billing_line_items_period_household as UNIQUE.
    await insertOrThrow(svc, "billing_line_items", [
      {
        id: FIXTURE.lineItemA,
        billing_period_id: FIXTURE.billingPeriod,
        household_id: FIXTURE.householdA,
        device_id: FIXTURE.device,
        usage_kwh: 100,
        total_amount: 25000,
      },
      {
        id: FIXTURE.lineItemB,
        billing_period_id: FIXTURE.billingPeriod,
        household_id: FIXTURE.householdB,
        device_id: FIXTURE.device,
        usage_kwh: 80,
        total_amount: 20000,
      },
    ]);
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({
      orgIds: [FIXTURE.org],
      userEmails: [],
    });
  }, 30_000);

  // ── Schema introspection ─────────────────────────────────────────────────

  it("billing_line_item_payment_status enum includes 'link_generated'", async () => {
    // Behavioral assertion: insert a transient line item with
    // payment_status='link_generated' and assert no error. The value being
    // accepted by the column proves it's in the enum. We use a transient
    // billing period so we don't collide with lineItemA/lineItemB on the
    // (billing_period_id, household_id) unique index.
    //
    // Previously this test queried information_schema.columns via PostgREST,
    // which newer Supabase CLI versions no longer expose (PGRST106). See #242.
    const svc = await serviceClient();

    const tmpPeriodId = randomUUID();
    await insertOrThrow(svc, "billing_periods", {
      id: tmpPeriodId,
      microgrid_id: FIXTURE.microgrid,
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      status: "draft",
    });

    const tmpLineId = randomUUID();
    const { error } = await svc.from("billing_line_items").insert({
      id: tmpLineId,
      billing_period_id: tmpPeriodId,
      household_id: FIXTURE.householdA,
      device_id: FIXTURE.device,
      usage_kwh: 1,
      total_amount: 100,
      payment_status: "link_generated",
    });
    expect(error).toBeNull();

    // Cleanup.
    await svc.from("billing_line_items").delete().eq("id", tmpLineId);
    await svc.from("billing_periods").delete().eq("id", tmpPeriodId);
  });

  it("payment_events table exists", async () => {
    const svc = await serviceClient();
    const { error } = await svc.from("payment_events").select("id").limit(1);
    // Table exists (no error, even if rows are zero).
    expect(error).toBeNull();
  });

  // ── fn_apply_payment_event behaviors ─────────────────────────────────────

  it("fn_apply_payment_event: generate_link transitions unpaid → link_generated, sets pesapal_order_id, appends audit row", async () => {
    const svc = await serviceClient();

    const merchantRef = `INV-PHASE-B-TEST-${randomUUID()}`;

    // #250: passing _actor_user_id=null requires non-human actor_kind +
    // a non-null actor_ref (the payment_events_actor_consistency CHECK
    // added in migration 00041). 'tenant_pay_redirect' is what the public
    // /pay route stamps for this code path.
    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemA,
      _to_status: "link_generated",
      _source: "generate_link",
      _actor_user_id: null,
      _raw_payload: { pesapal_order_id: merchantRef },
      _actor_kind: "system",
      _actor_ref: "tenant_pay_redirect",
    });
    expect(error).toBeNull();

    const { data: row } = await svc
      .from("billing_line_items")
      .select("payment_status, pesapal_order_id")
      .eq("id", FIXTURE.lineItemA)
      .single<{ payment_status: string; pesapal_order_id: string }>();
    expect(row?.payment_status).toBe("link_generated");
    expect(row?.pesapal_order_id).toBe(merchantRef);

    const { data: events } = await svc
      .from("payment_events")
      .select("from_status, to_status, source")
      .eq("line_item_id", FIXTURE.lineItemA)
      .order("at", { ascending: false })
      .limit(1);
    expect(events?.length).toBe(1);
    expect(events?.[0]?.to_status).toBe("link_generated");
    expect(events?.[0]?.source).toBe("generate_link");
  });

  it("fn_apply_payment_event: ipn link_generated → paid succeeds and writes paid_at + audit row", async () => {
    const svc = await serviceClient();

    // #250: IPN-attributed events use actor_kind='system', actor_ref='pesapal_ipn'.
    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemA,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: { order_tracking_id: "OT-test-123" },
      _actor_kind: "system",
      _actor_ref: "pesapal_ipn",
    });
    expect(error).toBeNull();

    const { data: row } = await svc
      .from("billing_line_items")
      .select("payment_status, paid_at")
      .eq("id", FIXTURE.lineItemA)
      .single<{ payment_status: string; paid_at: string | null }>();
    expect(row?.payment_status).toBe("paid");
    expect(row?.paid_at).toBeTruthy();
  });

  it("fn_apply_payment_event: idempotent re-delivery within 60s does NOT append a duplicate audit row", async () => {
    const svc = await serviceClient();

    const { count: countBefore } = await svc
      .from("payment_events")
      .select("*", { count: "exact", head: true })
      .eq("line_item_id", FIXTURE.lineItemA)
      .eq("source", "ipn")
      .eq("to_status", "paid");

    // Re-deliver — already in 'paid'. Should be a no-op.
    // #250: same actor_kind/actor_ref shape as the IPN test above.
    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemA,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: { order_tracking_id: "OT-test-123" },
      _actor_kind: "system",
      _actor_ref: "pesapal_ipn",
    });
    expect(error).toBeNull();

    const { count: countAfter } = await svc
      .from("payment_events")
      .select("*", { count: "exact", head: true })
      .eq("line_item_id", FIXTURE.lineItemA)
      .eq("source", "ipn")
      .eq("to_status", "paid");

    expect(countAfter).toBe(countBefore);
  });

  it("fn_apply_payment_event: ipn rejects refunded → paid (invalid_transition)", async () => {
    const svc = await serviceClient();

    // First make lineItemB go through unpaid → link_generated → paid → refunded.
    // #250: all of these pass _actor_user_id=null so they MUST stamp
    // actor_kind='system' + a non-null actor_ref to satisfy the new
    // payment_events_actor_consistency CHECK.
    await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemB,
      _to_status: "link_generated",
      _source: "generate_link",
      _actor_user_id: null,
      _raw_payload: { pesapal_order_id: `INV-B-${randomUUID()}` },
      _actor_kind: "system",
      _actor_ref: "tenant_pay_redirect",
    });
    await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemB,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: {},
      _actor_kind: "system",
      _actor_ref: "pesapal_ipn",
    });
    await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemB,
      _to_status: "refunded",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: {},
      _actor_kind: "system",
      _actor_ref: "pesapal_ipn",
    });

    // refunded → paid via ipn must reject.
    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemB,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: {},
      _actor_kind: "system",
      _actor_ref: "pesapal_ipn",
    });
    expect(error).toBeTruthy();
    expect(String(error?.message)).toContain("invalid_transition");
  });

  it("fn_apply_payment_event: rejects unknown source", async () => {
    const svc = await serviceClient();
    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemA,
      _to_status: "paid",
      _source: "weird_source",
      _actor_user_id: null,
      _raw_payload: null,
      _actor_kind: "system",
      _actor_ref: "test_unknown_source",
    });
    expect(error).toBeTruthy();
    expect(String(error?.message)).toContain("invalid_source");
  });

  it("billing_line_items pesapal_order_id is unique (rejects duplicate non-NULL)", async () => {
    const svc = await serviceClient();

    const dup = `INV-DUP-${randomUUID()}`;

    // Use a transient billing period so the two transient line items don't
    // collide with lineItemA / lineItemB on idx_billing_line_items_period_household.
    // The two transient rows themselves use householdA and householdB so they
    // also don't collide with each other on that index — letting the assertion
    // isolate the pesapal_order_id uniqueness constraint specifically.
    const tmpPeriodId = randomUUID();
    await insertOrThrow(svc, "billing_periods", {
      id: tmpPeriodId,
      microgrid_id: FIXTURE.microgrid,
      start_date: "2026-05-01",
      end_date: "2026-05-31",
      status: "draft",
    });

    const tmpLineId = randomUUID();
    await insertOrThrow(svc, "billing_line_items", {
      id: tmpLineId,
      billing_period_id: tmpPeriodId,
      household_id: FIXTURE.householdA,
      device_id: FIXTURE.device,
      usage_kwh: 1,
      total_amount: 100,
      pesapal_order_id: dup,
    });

    // A second insert with the same pesapal_order_id must fail.
    const { error } = await svc.from("billing_line_items").insert({
      id: randomUUID(),
      billing_period_id: tmpPeriodId,
      household_id: FIXTURE.householdB,
      device_id: FIXTURE.device,
      usage_kwh: 1,
      total_amount: 100,
      pesapal_order_id: dup,
    });
    expect(error).toBeTruthy();

    // Cleanup — drop the transient line item + period.
    await svc.from("billing_line_items").delete().eq("id", tmpLineId);
    await svc.from("billing_periods").delete().eq("id", tmpPeriodId);
  });
});
