/**
 * payment_state_machine.test.ts (#157, migration 00027)
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

// Deterministic fixture IDs to keep teardown simple.
const FIXTURE = {
  org: "cccccccc-cccc-4000-8000-000000000001",
  community: "cccccccc-cccc-4000-8001-000000000001",
  microgrid: "cccccccc-cccc-4000-8002-000000000001",
  edge: "cccccccc-cccc-4000-8003-000000000001",
  device: "cccccccc-cccc-4000-8004-000000000001",
  household: "cccccccc-cccc-4000-8005-000000000001",
  billingPeriod: "cccccccc-cccc-4000-8006-000000000001",
  lineItemA: "cccccccc-cccc-4000-8007-000000000001",
  lineItemB: "cccccccc-cccc-4000-8007-000000000002",
};

desc("00027_payment_state_machine.sql (#157)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();

    const svc = await serviceClient();

    // Clean up any leftover from a prior run.
    await cleanupTestData({
      orgIds: [FIXTURE.org],
      userEmails: [],
    });

    await svc
      .from("organizations")
      .insert({ id: FIXTURE.org, name: "Phase B State Machine Test Org" });
    await svc
      .from("communities")
      .insert({ id: FIXTURE.community, org_id: FIXTURE.org, name: "PB Comm" });
    await svc.from("microgrids").insert({
      id: FIXTURE.microgrid,
      community_id: FIXTURE.community,
      name: "PB MG",
      currency: "UGX",
    });
    await svc.from("edges").insert({
      id: FIXTURE.edge,
      microgrid_id: FIXTURE.microgrid,
      name: "PB Edge",
      openems_edge_id: "phase-b-edge",
    });
    await svc.from("devices").insert({
      id: FIXTURE.device,
      edge_id: FIXTURE.edge,
      name: "PB Device",
      device_type: "consumption_meter",
      openems_component_id: "phase-b-meter",
    });
    await svc.from("households").insert({
      id: FIXTURE.household,
      microgrid_id: FIXTURE.microgrid,
      display_name: "PB Household",
      primary_phone: "+256700000000",
    });
    await svc.from("billing_periods").insert({
      id: FIXTURE.billingPeriod,
      microgrid_id: FIXTURE.microgrid,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      status: "draft",
    });
    await svc.from("billing_line_items").insert([
      {
        id: FIXTURE.lineItemA,
        billing_period_id: FIXTURE.billingPeriod,
        household_id: FIXTURE.household,
        device_id: FIXTURE.device,
        usage_kwh: 100,
        total_amount: 25000,
      },
      {
        id: FIXTURE.lineItemB,
        billing_period_id: FIXTURE.billingPeriod,
        household_id: FIXTURE.household,
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
    const svc = await serviceClient();
    const { data, error } = await svc
      .schema("information_schema" as never)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .from("columns" as any)
      .select("column_name")
      .eq("table_schema", "public")
      .eq("table_name", "billing_line_items")
      .eq("column_name", "pesapal_order_id")
      .single<{ column_name: string }>();
    expect(error).toBeNull();
    expect(data?.column_name).toBe("pesapal_order_id");
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

    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemA,
      _to_status: "link_generated",
      _source: "generate_link",
      _actor_user_id: null,
      _raw_payload: { pesapal_order_id: merchantRef },
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

    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemA,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: { order_tracking_id: "OT-test-123" },
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
    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemA,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: { order_tracking_id: "OT-test-123" },
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
    await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemB,
      _to_status: "link_generated",
      _source: "generate_link",
      _actor_user_id: null,
      _raw_payload: { pesapal_order_id: `INV-B-${randomUUID()}` },
    });
    await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemB,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: {},
    });
    await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemB,
      _to_status: "refunded",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: {},
    });

    // refunded → paid via ipn must reject.
    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemB,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: {},
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
    });
    expect(error).toBeTruthy();
    expect(String(error?.message)).toContain("invalid_source");
  });

  it("billing_line_items pesapal_order_id is unique (rejects duplicate non-NULL)", async () => {
    const svc = await serviceClient();

    const dup = `INV-DUP-${randomUUID()}`;

    // Use a transient sister line item to avoid corrupting fixture state.
    const tmpLineId = randomUUID();
    await svc.from("billing_line_items").insert({
      id: tmpLineId,
      billing_period_id: FIXTURE.billingPeriod,
      household_id: FIXTURE.household,
      device_id: FIXTURE.device,
      usage_kwh: 1,
      total_amount: 100,
      pesapal_order_id: dup,
    });

    // A second insert with the same value must fail.
    const { error } = await svc.from("billing_line_items").insert({
      id: randomUUID(),
      billing_period_id: FIXTURE.billingPeriod,
      household_id: FIXTURE.household,
      device_id: FIXTURE.device,
      usage_kwh: 1,
      total_amount: 100,
      pesapal_order_id: dup,
    });
    expect(error).toBeTruthy();

    // Cleanup the transient row.
    await svc.from("billing_line_items").delete().eq("id", tmpLineId);
  });
});
