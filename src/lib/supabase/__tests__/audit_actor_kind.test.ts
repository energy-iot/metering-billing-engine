/**
 * audit_actor_kind.test.ts (#250, migration 00041)
 *
 * Verifies the actor-attribution refactor against a live local Supabase:
 *
 *   1. New columns `actor_kind` (TEXT, NOT NULL, DEFAULT 'human') and
 *      `actor_ref` (TEXT, NULL) exist on both billing_audit_log and
 *      payment_events.
 *
 *   2. The composite CHECK (`billing_audit_log_actor_consistency` +
 *      `payment_events_actor_consistency`) enforces the shape invariant:
 *
 *        human       → actor_user_id NOT NULL, actor_ref NULL
 *        non-human   → actor_user_id NULL,     actor_ref NOT NULL
 *
 *   3. End-to-end: `fn_record_line_item_with_audit` invoked with the
 *      widened-signature args from `/api/v1/billing/generate`
 *      (`_actor_user_id=NULL, _actor_kind='customerapp', _actor_ref=...`)
 *      successfully inserts a billing_line_items row AND a billing_audit_log
 *      row — no FK violation. This is the PM AC "First call to
 *      `POST /api/v1/billing/generate` succeeds end-to-end".
 *
 *   4. Human-actor calls (the existing call-path: actor_kind defaults to
 *      `'human'`, actor_user_id non-null, actor_ref omitted) continue to
 *      work unchanged — backwards compatibility AC.
 *
 *   5. `actor_kind = 'human' AND actor_user_id IS NULL` is rejected by the
 *      composite CHECK — sanity check on the new constraint composition.
 *
 *   6. `actor_kind` outside the allowed domain (`'human' | 'customerapp' |
 *      'system'`) is rejected by the inline CHECK on the column.
 *
 * Honors `SKIP_RLS_TESTS=1` for CI without local Supabase (same pattern as
 * payment_state_machine.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[audit_actor_kind] SKIP_RLS_TESTS=1 — skipping suite.");
}

// Fail-loud insert helper — surface fixture drift instead of silently
// swallowing PostgREST errors. Per the #242 lesson.
async function insertOrThrow(
  client: SupabaseClient,
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await client.from(table).insert(rows as any);
  if (error) {
    throw new Error(
      `[audit_actor_kind] fixture insert failed on ${table}: ${error.message}`,
    );
  }
}

// Deterministic fixture IDs.
const FIXTURE = {
  org: "aaaaaaaa-aaaa-4000-8250-000000000001",
  community: "aaaaaaaa-aaaa-4000-8251-000000000001",
  microgrid: "aaaaaaaa-aaaa-4000-8252-000000000001",
  edge: "aaaaaaaa-aaaa-4000-8253-000000000001",
  device: "aaaaaaaa-aaaa-4000-8254-000000000001",
  household: "aaaaaaaa-aaaa-4000-8255-000000000001",
  billingPeriod: "aaaaaaaa-aaaa-4000-8256-000000000001",
};

const TEST_USER_EMAIL = `audit-actor-kind-${Date.now()}@example.invalid`;

desc("00041_audit_actor_kind.sql (#250) — actor_kind / actor_ref columns + CHECK constraints", () => {
  let testUserId: string;

  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();

    const svc = await serviceClient();

    // Clean up any leftover from a prior run.
    await cleanupTestData({
      orgIds: [FIXTURE.org],
      userEmails: [TEST_USER_EMAIL],
    });

    // Create a real auth user — the human-actor positive case needs a row
    // in auth.users so the FK on actor_user_id is satisfiable.
    const tu = await createTestUser({
      email: TEST_USER_EMAIL,
      role: "super_admin",
    });
    testUserId = tu.userId;

    await insertOrThrow(svc, "organizations", {
      id: FIXTURE.org,
      name: "#250 Audit Actor Kind Test Org",
    });
    await insertOrThrow(svc, "communities", {
      id: FIXTURE.community,
      org_id: FIXTURE.org,
      name: "AK Comm",
    });
    await insertOrThrow(svc, "microgrids", {
      id: FIXTURE.microgrid,
      community_id: FIXTURE.community,
      name: "AK MG",
      currency: "UGX",
    });
    await insertOrThrow(svc, "edges", {
      id: FIXTURE.edge,
      microgrid_id: FIXTURE.microgrid,
      name: "AK Edge",
      openems_edge_id: "ak-edge",
    });
    await insertOrThrow(svc, "devices", {
      id: FIXTURE.device,
      edge_id: FIXTURE.edge,
      name: "AK Device",
      device_type: "consumption_meter",
      openems_component_id: "ak-meter",
    });
    await insertOrThrow(svc, "households", {
      id: FIXTURE.household,
      microgrid_id: FIXTURE.microgrid,
      display_name: "AK Household",
      primary_phone: "+256700000250",
    });
    await insertOrThrow(svc, "billing_periods", {
      id: FIXTURE.billingPeriod,
      microgrid_id: FIXTURE.microgrid,
      start_date: "2026-05-01",
      end_date: "2026-05-31",
      status: "draft",
    });
  }, 60_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({
      orgIds: [FIXTURE.org],
      userEmails: [TEST_USER_EMAIL],
    });
  }, 30_000);

  // ── PM AC matrix ─────────────────────────────────────────────────────────

  it("AC: actor_kind='customerapp' + actor_user_id=NULL is permitted (covers the FK-free fix for #250)", async () => {
    const svc = await serviceClient();

    const { error } = await svc.from("billing_audit_log").insert({
      billing_period_id: FIXTURE.billingPeriod,
      event_type: "billing_period_created",
      actor_user_id: null,
      actor_kind: "customerapp",
      actor_ref: "test-customerapp-token",
      details: { test: "ac-customerapp" },
    });
    expect(error).toBeNull();
  });

  it("AC: actor_kind='system' + actor_user_id=NULL is permitted (covers IPN-attributed payment_events)", async () => {
    const svc = await serviceClient();

    // First mint a line item to attach the payment event to.
    const lineItemId = randomUUID();
    await insertOrThrow(svc, "billing_line_items", {
      id: lineItemId,
      billing_period_id: FIXTURE.billingPeriod,
      household_id: FIXTURE.household,
      device_id: FIXTURE.device,
      usage_kwh: 50,
      total_amount: 12500,
    });

    const { error } = await svc.from("payment_events").insert({
      line_item_id: lineItemId,
      from_status: "unpaid",
      to_status: "link_generated",
      source: "ipn",
      actor_user_id: null,
      actor_kind: "system",
      actor_ref: "pesapal_ipn",
      raw_payload: { test: "ac-system" },
    });
    expect(error).toBeNull();

    // Cleanup line item (the audit + payment_events cascade on delete).
    await svc.from("billing_line_items").delete().eq("id", lineItemId);
  });

  it("AC: actor_kind='human' + actor_user_id NOT NULL + actor_ref NULL is permitted (existing call path unchanged)", async () => {
    const svc = await serviceClient();

    const { error } = await svc.from("billing_audit_log").insert({
      billing_period_id: FIXTURE.billingPeriod,
      event_type: "period_created",
      actor_user_id: testUserId,
      // actor_kind defaults to 'human'; actor_ref defaults to NULL.
      details: { test: "ac-human-default" },
    });
    expect(error).toBeNull();
  });

  it("AC: actor_kind='human' + actor_user_id=NULL is rejected by the composite CHECK", async () => {
    const svc = await serviceClient();

    const { error } = await svc.from("billing_audit_log").insert({
      billing_period_id: FIXTURE.billingPeriod,
      event_type: "period_created",
      actor_user_id: null,
      actor_kind: "human",
      actor_ref: null,
      details: { test: "ac-human-no-user" },
    });
    expect(error).not.toBeNull();
    // 23514 = check_violation
    expect(error?.code).toBe("23514");
    expect(error?.message ?? "").toMatch(/actor_consistency/);
  });

  it("AC: actor_kind outside ('human'|'customerapp'|'system') is rejected by the inline CHECK", async () => {
    const svc = await serviceClient();

    const { error } = await svc.from("billing_audit_log").insert({
      billing_period_id: FIXTURE.billingPeriod,
      event_type: "period_created",
      actor_user_id: testUserId,
      actor_kind: "robot", // not in the domain
      actor_ref: null,
      details: { test: "ac-bad-kind" },
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514"); // check_violation
  });

  it("AC: actor_kind='customerapp' + actor_user_id NOT NULL is rejected by the composite CHECK (non-human must NOT carry user_id)", async () => {
    const svc = await serviceClient();

    const { error } = await svc.from("billing_audit_log").insert({
      billing_period_id: FIXTURE.billingPeriod,
      event_type: "billing_period_created",
      actor_user_id: testUserId, // forbidden when actor_kind != 'human'
      actor_kind: "customerapp",
      actor_ref: "token-name",
      details: { test: "ac-customerapp-with-user" },
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
    expect(error?.message ?? "").toMatch(/actor_consistency/);
  });

  it("AC: actor_kind='customerapp' + actor_ref NULL is rejected by the composite CHECK (non-human must carry ref)", async () => {
    const svc = await serviceClient();

    const { error } = await svc.from("billing_audit_log").insert({
      billing_period_id: FIXTURE.billingPeriod,
      event_type: "billing_period_created",
      actor_user_id: null,
      actor_kind: "customerapp",
      actor_ref: null, // forbidden when actor_kind != 'human'
      details: { test: "ac-customerapp-no-ref" },
    });
    expect(error).not.toBeNull();
    expect(error?.code).toBe("23514");
    expect(error?.message ?? "").toMatch(/actor_consistency/);
  });

  // ── End-to-end: fn_record_line_item_with_audit via the customerapp path ──

  it("E2E: fn_record_line_item_with_audit({_actor_user_id: null, _actor_kind: 'customerapp', _actor_ref: '...'}) succeeds with no FK violation (the #250 root-cause fix)", async () => {
    const svc = await serviceClient();

    // Use a fresh household to avoid colliding with the (period, household)
    // unique index from prior tests.
    const householdB = "aaaaaaaa-aaaa-4000-8255-000000000002";
    await insertOrThrow(svc, "households", {
      id: householdB,
      microgrid_id: FIXTURE.microgrid,
      display_name: "AK Household E2E",
      primary_phone: "+256700000251",
    });

    const { data, error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.billingPeriod,
      _household_id: householdB,
      _device_id: FIXTURE.device,
      _usage_kwh: 120,
      _start_kwh: 1000,
      _end_kwh: 1120,
      _tier_breakdown: [{ label: "T1", kwh: 120, amount: 30000 }],
      _total_amount: 30000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: null,
      _audit_details: {},
      _actor_kind: "customerapp",
      _actor_ref: "pre-token-system",
    });

    expect(error).toBeNull();
    expect(data).toBeTruthy();

    // Verify the audit row was written with the correct attribution.
    const { data: audit, error: auditErr } = await svc
      .from("billing_audit_log")
      .select("actor_user_id, actor_kind, actor_ref, event_type")
      .eq("billing_period_id", FIXTURE.billingPeriod)
      .eq("billing_line_item_id", (data as { id: string }).id);
    expect(auditErr).toBeNull();
    expect(audit).toHaveLength(1);
    expect(audit![0].actor_user_id).toBeNull();
    expect(audit![0].actor_kind).toBe("customerapp");
    expect(audit![0].actor_ref).toBe("pre-token-system");
    expect(audit![0].event_type).toBe("line_item_generated");
  });

  it("E2E: fn_record_line_item_with_audit with the legacy human-actor call shape (no _actor_kind / _actor_ref) defaults to actor_kind='human' and succeeds", async () => {
    const svc = await serviceClient();

    const householdC = "aaaaaaaa-aaaa-4000-8255-000000000003";
    await insertOrThrow(svc, "households", {
      id: householdC,
      microgrid_id: FIXTURE.microgrid,
      display_name: "AK Household E2E Human",
      primary_phone: "+256700000252",
    });

    const { data, error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.billingPeriod,
      _household_id: householdC,
      _device_id: FIXTURE.device,
      _usage_kwh: 80,
      _start_kwh: 500,
      _end_kwh: 580,
      _tier_breakdown: [{ label: "T1", kwh: 80, amount: 20000 }],
      _total_amount: 20000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: testUserId,
      _audit_details: {},
      // _actor_kind / _actor_ref intentionally omitted — should default.
    });

    expect(error).toBeNull();
    expect(data).toBeTruthy();

    const { data: audit, error: auditErr } = await svc
      .from("billing_audit_log")
      .select("actor_user_id, actor_kind, actor_ref")
      .eq("billing_period_id", FIXTURE.billingPeriod)
      .eq("billing_line_item_id", (data as { id: string }).id);
    expect(auditErr).toBeNull();
    expect(audit).toHaveLength(1);
    expect(audit![0].actor_user_id).toBe(testUserId);
    expect(audit![0].actor_kind).toBe("human");
    expect(audit![0].actor_ref).toBeNull();
  });
});
