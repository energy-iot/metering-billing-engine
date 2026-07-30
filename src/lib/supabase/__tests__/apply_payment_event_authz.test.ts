/**
 * apply_payment_event_authz.test.ts (migration 00050)
 *
 * Exercises the body-side authorization gate and the server-derived audit
 * actor on `fn_apply_payment_event`.
 *
 * Why a new suite rather than extending payment_state_machine.test.ts:
 * that suite drives every call through the service-role client, which takes
 * the bypass branch of the gate and therefore cannot observe either change.
 * The route-level unit tests mock `.rpc` outright. Neither would catch a
 * regression here — the authenticated path has to be driven with a real
 * user-bound JWT, which is what `clientAs()` from rls.helpers provides.
 *
 * Assertions:
 *   1. An authenticated caller WITHOUT access to the line item's org is
 *      refused by the function body (42501), and no state change occurs.
 *   2. A service-role caller still succeeds and its supplied actor triple
 *      survives verbatim (IPN / public-pay path).
 *   3. An authenticated caller WITH access has its supplied actor triple
 *      ignored — the recorded row carries auth.uid(), 'human', NULL — even
 *      when it passes a forged non-human actor.
 *
 * Prerequisites: same as the rest of the RLS suite (local Supabase +
 * SUPABASE_JWT_SECRET). Honors SKIP_RLS_TESTS=1.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  createTestUser,
  cleanupTestData,
  type TestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[apply_payment_event_authz] SKIP_RLS_TESTS=1 — skipping suite.");
}

async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(
      `[apply_payment_event_authz] fixture insert failed on ${table}: ${error.message}`,
    );
  }
}

// Deterministic fixture IDs — 'dddd' prefix keeps this suite's org distinct
// from rls.test.ts ('aaaa'/'bbbb') and payment_state_machine.test.ts ('cccc'),
// so parallel/sequential runs never collide on teardown.
const FIXTURE = {
  orgOwner: "dddddddd-dddd-4000-8000-000000000001",
  orgOther: "dddddddd-dddd-4000-8000-000000000002",
  community: "dddddddd-dddd-4000-8001-000000000001",
  microgrid: "dddddddd-dddd-4000-8002-000000000001",
  edge: "dddddddd-dddd-4000-8003-000000000001",
  device: "dddddddd-dddd-4000-8004-000000000001",
  householdA: "dddddddd-dddd-4000-8005-000000000001",
  householdB: "dddddddd-dddd-4000-8005-000000000002",
  householdC: "dddddddd-dddd-4000-8005-000000000003",
  billingPeriod: "dddddddd-dddd-4000-8006-000000000001",
  lineItemDenied: "dddddddd-dddd-4000-8007-000000000001",
  lineItemService: "dddddddd-dddd-4000-8007-000000000002",
  lineItemHuman: "dddddddd-dddd-4000-8007-000000000003",
};

const TEST_EMAILS = [
  "ape-authz-insider@test.local",
  "ape-authz-outsider@test.local",
];

let insider: TestUser; // org_manager scoped to the OWNING org
let outsider: TestUser; // org_manager scoped to an unrelated org

desc("00050_apply_payment_event_authz.sql — body-side gate + derived actor", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();

    const svc = await serviceClient();

    await cleanupTestData({
      orgIds: [FIXTURE.orgOwner, FIXTURE.orgOther],
      userEmails: TEST_EMAILS,
    });

    await insertOrThrow(svc, "organizations", [
      { id: FIXTURE.orgOwner, name: "APE Authz Owning Org" },
      { id: FIXTURE.orgOther, name: "APE Authz Unrelated Org" },
    ]);
    await insertOrThrow(svc, "communities", {
      id: FIXTURE.community,
      org_id: FIXTURE.orgOwner,
      name: "APE Authz Comm",
    });
    await insertOrThrow(svc, "microgrids", {
      id: FIXTURE.microgrid,
      community_id: FIXTURE.community,
      name: "APE Authz MG",
      currency: "UGX",
    });
    await insertOrThrow(svc, "edges", {
      id: FIXTURE.edge,
      microgrid_id: FIXTURE.microgrid,
      name: "APE Authz Edge",
      openems_edge_id: "ape-authz-edge",
    });
    await insertOrThrow(svc, "devices", {
      id: FIXTURE.device,
      edge_id: FIXTURE.edge,
      name: "APE Authz Device",
      device_type: "consumption_meter",
      openems_component_id: "ape-authz-meter",
    });
    await insertOrThrow(svc, "households", [
      {
        id: FIXTURE.householdA,
        microgrid_id: FIXTURE.microgrid,
        display_name: "APE Authz Household A",
        primary_phone: "+256710000001",
      },
      {
        id: FIXTURE.householdB,
        microgrid_id: FIXTURE.microgrid,
        display_name: "APE Authz Household B",
        primary_phone: "+256710000002",
      },
      {
        id: FIXTURE.householdC,
        microgrid_id: FIXTURE.microgrid,
        display_name: "APE Authz Household C",
        primary_phone: "+256710000003",
      },
    ]);
    await insertOrThrow(svc, "billing_periods", {
      id: FIXTURE.billingPeriod,
      microgrid_id: FIXTURE.microgrid,
      start_date: "2026-05-01",
      end_date: "2026-05-31",
      status: "draft",
    });
    // One line item per test — (billing_period_id, household_id) is UNIQUE
    // (migration 00029), so each needs its own household.
    await insertOrThrow(svc, "billing_line_items", [
      {
        id: FIXTURE.lineItemDenied,
        billing_period_id: FIXTURE.billingPeriod,
        household_id: FIXTURE.householdA,
        device_id: FIXTURE.device,
        usage_kwh: 10,
        total_amount: 1000,
      },
      {
        id: FIXTURE.lineItemService,
        billing_period_id: FIXTURE.billingPeriod,
        household_id: FIXTURE.householdB,
        device_id: FIXTURE.device,
        usage_kwh: 20,
        total_amount: 2000,
      },
      {
        id: FIXTURE.lineItemHuman,
        billing_period_id: FIXTURE.billingPeriod,
        household_id: FIXTURE.householdC,
        device_id: FIXTURE.device,
        usage_kwh: 30,
        total_amount: 3000,
      },
    ]);

    insider = await createTestUser({
      email: TEST_EMAILS[0],
      role: "org_manager",
      scopeId: FIXTURE.orgOwner,
    });
    outsider = await createTestUser({
      email: TEST_EMAILS[1],
      role: "org_manager",
      scopeId: FIXTURE.orgOther,
    });
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({
      orgIds: [FIXTURE.orgOwner, FIXTURE.orgOther],
      userEmails: TEST_EMAILS,
    });
  }, 30_000);

  // ── 1. Deny-by-default gate ────────────────────────────────────────────

  it("refuses an authenticated caller with no access to the line item's org", async () => {
    const { error } = await outsider.client.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemDenied,
      _to_status: "paid",
      _source: "manual",
      _actor_user_id: outsider.userId,
      _raw_payload: null,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");

    // The refusal happened before any mutation.
    const svc = await serviceClient();
    const { data: row } = await svc
      .from("billing_line_items")
      .select("payment_status, paid_at")
      .eq("id", FIXTURE.lineItemDenied)
      .single();
    expect(row?.payment_status).toBe("unpaid");
    expect(row?.paid_at).toBeNull();

    const { data: events } = await svc
      .from("payment_events")
      .select("id")
      .eq("line_item_id", FIXTURE.lineItemDenied);
    expect(events ?? []).toHaveLength(0);
  });

  it("refuses an authenticated caller for a line item that does not exist", async () => {
    // No membership can be proven for an absent line item, so the gate must
    // refuse rather than fall through to the not-found path.
    const { error } = await outsider.client.rpc("fn_apply_payment_event", {
      _line_item_id: randomUUID(),
      _to_status: "paid",
      _source: "manual",
      _actor_user_id: outsider.userId,
      _raw_payload: null,
    });
    expect(error?.code).toBe("42501");
  });

  // ── 2. service_role bypass keeps its supplied actor ────────────────────

  it("lets service_role through and preserves its supplied actor triple", async () => {
    const svc = await serviceClient();

    const { error } = await svc.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemService,
      _to_status: "paid",
      _source: "ipn",
      _actor_user_id: null,
      _raw_payload: { pesapal_order_id: `APE-AUTHZ-${randomUUID()}` },
      _actor_kind: "system",
      _actor_ref: "pesapal_ipn",
    });
    expect(error).toBeNull();

    const { data: row } = await svc
      .from("billing_line_items")
      .select("payment_status")
      .eq("id", FIXTURE.lineItemService)
      .single();
    expect(row?.payment_status).toBe("paid");

    const { data: events } = await svc
      .from("payment_events")
      .select("actor_user_id, actor_kind, actor_ref, to_status")
      .eq("line_item_id", FIXTURE.lineItemService)
      .order("at", { ascending: false });

    expect(events?.[0]?.to_status).toBe("paid");
    expect(events?.[0]?.actor_kind).toBe("system");
    expect(events?.[0]?.actor_ref).toBe("pesapal_ipn");
    expect(events?.[0]?.actor_user_id).toBeNull();
  });

  // ── 3. Session caller's supplied actor triple is ignored ───────────────

  it("ignores a session caller's supplied actor triple and records auth.uid() / 'human' / NULL", async () => {
    // Forge every field the caller controls: someone else's user id, a
    // non-human kind, and an actor_ref. All three must be discarded.
    const { error } = await insider.client.rpc("fn_apply_payment_event", {
      _line_item_id: FIXTURE.lineItemHuman,
      _to_status: "paid",
      _source: "manual",
      _actor_user_id: outsider.userId,
      _raw_payload: null,
      _actor_kind: "system",
      _actor_ref: "forged_actor_ref",
    });
    expect(error).toBeNull();

    const svc = await serviceClient();
    const { data: events } = await svc
      .from("payment_events")
      .select("actor_user_id, actor_kind, actor_ref, to_status")
      .eq("line_item_id", FIXTURE.lineItemHuman)
      .order("at", { ascending: false });

    expect(events?.[0]?.to_status).toBe("paid");
    expect(events?.[0]?.actor_user_id).toBe(insider.userId);
    expect(events?.[0]?.actor_user_id).not.toBe(outsider.userId);
    expect(events?.[0]?.actor_kind).toBe("human");
    expect(events?.[0]?.actor_ref).toBeNull();

    // paid_by_user_id takes the derived actor too, not the forged one.
    const { data: row } = await svc
      .from("billing_line_items")
      .select("payment_status, paid_by_user_id")
      .eq("id", FIXTURE.lineItemHuman)
      .single();
    expect(row?.payment_status).toBe("paid");
    expect(row?.paid_by_user_id).toBe(insider.userId);
  });
});
