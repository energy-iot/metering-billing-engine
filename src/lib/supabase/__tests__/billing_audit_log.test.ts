/**
 * billing_audit_log.test.ts (#173, migration 00029)
 *
 * Verifies BC1's migration end-to-end against a live local Supabase:
 *   - Schema introspection: enums + table + index + columns exist.
 *   - fn_record_line_item_with_audit ARRIVES (signature smoke test).
 *   - INSERT path lands a billing_line_items row AND a billing_audit_log row
 *     in one transaction. event_type = 'line_item_generated' (xmax=0 path).
 *   - UPDATE-via-CONFLICT preserves payment_status / paid_at / paid_by_user_id
 *     for a paid row. event_type = 'line_item_regenerated'. payment_events
 *     for that line_item_id are NOT cascaded away.
 *   - period_was_closed: true is appended to details when period.status='closed'.
 *   - Failed audit insert rolls back the line item upsert (negative test —
 *     contrived constraint violation on details).
 *   - RLS on billing_audit_log:
 *       * org_manager A SELECTs their org's entries
 *       * org_manager A cannot SELECT another org's entries
 *       * super_admin can SELECT both
 *       * UPDATE / DELETE rejected for everyone (including super_admin) —
 *         no policy = default deny via RLS.
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
  createTestUser,
} from "./rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[billing_audit_log] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  // Org/community/microgrid for tenant A.
  orgA: "dddddddd-dddd-4000-8000-00000000000a",
  commA: "dddddddd-dddd-4000-8001-00000000000a",
  mgA: "dddddddd-dddd-4000-8002-00000000000a",
  edgeA: "dddddddd-dddd-4000-8003-00000000000a",
  deviceA: "dddddddd-dddd-4000-8004-00000000000a",
  hhA: "dddddddd-dddd-4000-8005-00000000000a",
  periodA: "dddddddd-dddd-4000-8006-00000000000a",

  // Extra households on mgA, isolated from hhA so the link-invalidation
  // tests (#217 / 00037) can run against fresh rows without contaminating
  // the existing hhA-based assertions.
  hhA_inv1: "dddddddd-dddd-4000-8005-00000000001a",
  hhA_inv2: "dddddddd-dddd-4000-8005-00000000002a",
  hhA_inv3: "dddddddd-dddd-4000-8005-00000000003a",

  // Org/community/microgrid for tenant B (cross-org isolation tests).
  orgB: "dddddddd-dddd-4000-8000-00000000000b",
  commB: "dddddddd-dddd-4000-8001-00000000000b",
  mgB: "dddddddd-dddd-4000-8002-00000000000b",
  hhB: "dddddddd-dddd-4000-8005-00000000000b",
  periodB: "dddddddd-dddd-4000-8006-00000000000b",
};

// Test users created in beforeAll.
let alejandroSuperAdmin: { userId: string; jwt: string; client: import("@supabase/supabase-js").SupabaseClient };
let aaronOrgManagerA: { userId: string; jwt: string; client: import("@supabase/supabase-js").SupabaseClient };
let bobOrgManagerB: { userId: string; jwt: string; client: import("@supabase/supabase-js").SupabaseClient };

const EMAIL_SUPER = `bc1-super-${Date.now()}@test.local`;
const EMAIL_ORGA = `bc1-orga-${Date.now()}@test.local`;
const EMAIL_ORGB = `bc1-orgb-${Date.now()}@test.local`;

desc("00029_billing_line_item_source_and_audit.sql (#173)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();

    await cleanupTestData({
      orgIds: [FIXTURE.orgA, FIXTURE.orgB],
      userEmails: [EMAIL_SUPER, EMAIL_ORGA, EMAIL_ORGB],
    });

    // Org / community / microgrid / edge / device / household / period — A
    await svc.from("organizations").insert({ id: FIXTURE.orgA, name: "BC1 Org A" });
    await svc.from("communities").insert({ id: FIXTURE.commA, org_id: FIXTURE.orgA, name: "BC1 Comm A" });
    await svc.from("microgrids").insert({
      id: FIXTURE.mgA,
      community_id: FIXTURE.commA,
      name: "BC1 MG A",
      currency: "UGX",
    });
    await svc.from("edges").insert({
      id: FIXTURE.edgeA,
      microgrid_id: FIXTURE.mgA,
      name: "BC1 Edge A",
      openems_edge_id: "bc1-edge-a",
    });
    await svc.from("devices").insert({
      id: FIXTURE.deviceA,
      edge_id: FIXTURE.edgeA,
      name: "BC1 Dev A",
      device_type: "consumption_meter",
      openems_component_id: "bc1-meter-a",
    });
    await svc.from("households").insert({
      id: FIXTURE.hhA,
      microgrid_id: FIXTURE.mgA,
      display_name: "BC1 Household A",
      primary_phone: "+256700000001",
    });
    // Three extra households for the #217 link-invalidation cases (A/B/C).
    await svc.from("households").insert([
      {
        id: FIXTURE.hhA_inv1,
        microgrid_id: FIXTURE.mgA,
        display_name: "BC1 Household A-inv1",
        primary_phone: "+256700001001",
      },
      {
        id: FIXTURE.hhA_inv2,
        microgrid_id: FIXTURE.mgA,
        display_name: "BC1 Household A-inv2",
        primary_phone: "+256700001002",
      },
      {
        id: FIXTURE.hhA_inv3,
        microgrid_id: FIXTURE.mgA,
        display_name: "BC1 Household A-inv3",
        primary_phone: "+256700001003",
      },
    ]);
    await svc.from("billing_periods").insert({
      id: FIXTURE.periodA,
      microgrid_id: FIXTURE.mgA,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      status: "draft",
    });

    // Org / community / microgrid / household / period — B (cross-org)
    await svc.from("organizations").insert({ id: FIXTURE.orgB, name: "BC1 Org B" });
    await svc.from("communities").insert({ id: FIXTURE.commB, org_id: FIXTURE.orgB, name: "BC1 Comm B" });
    await svc.from("microgrids").insert({
      id: FIXTURE.mgB,
      community_id: FIXTURE.commB,
      name: "BC1 MG B",
      currency: "UGX",
    });
    await svc.from("households").insert({
      id: FIXTURE.hhB,
      microgrid_id: FIXTURE.mgB,
      display_name: "BC1 Household B",
      primary_phone: "+256700000002",
    });
    await svc.from("billing_periods").insert({
      id: FIXTURE.periodB,
      microgrid_id: FIXTURE.mgB,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      status: "draft",
    });

    // Test users
    alejandroSuperAdmin = await createTestUser({
      email: EMAIL_SUPER,
      role: "super_admin",
    });
    aaronOrgManagerA = await createTestUser({
      email: EMAIL_ORGA,
      role: "org_manager",
      scopeId: FIXTURE.orgA,
    });
    bobOrgManagerB = await createTestUser({
      email: EMAIL_ORGB,
      role: "org_manager",
      scopeId: FIXTURE.orgB,
    });
  }, 120_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({
      orgIds: [FIXTURE.orgA, FIXTURE.orgB],
      userEmails: [EMAIL_SUPER, EMAIL_ORGA, EMAIL_ORGB],
    });
  }, 60_000);

  // ── Schema introspection ──────────────────────────────────────────────────

  it("billing_line_item_reading_source enum exists with values 'edge' | 'manual'", async () => {
    const svc = await serviceClient();
    // Insert a line item with the new column to assert the enum is wired.
    const id = randomUUID();
    const { error } = await svc.from("billing_line_items").insert({
      id,
      billing_period_id: FIXTURE.periodA,
      household_id: FIXTURE.hhA,
      device_id: FIXTURE.deviceA,
      usage_kwh: 10,
      total_amount: 1000,
      reading_source: "manual",
    });
    expect(error).toBeNull();
    await svc.from("billing_line_items").delete().eq("id", id);
  });

  it("billing_audit_log table is queryable and starts empty for new periods", async () => {
    const svc = await serviceClient();
    const { data, error } = await svc
      .from("billing_audit_log")
      .select("id")
      .eq("billing_period_id", FIXTURE.periodA);
    expect(error).toBeNull();
    expect(data?.length ?? 0).toBe(0);
  });

  // ── fn_record_line_item_with_audit happy paths ────────────────────────────

  it("fn_record_line_item_with_audit: INSERT path writes a line item AND a 'line_item_generated' audit row", async () => {
    const svc = await serviceClient();
    const { error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 50,
      _start_kwh: 0,
      _end_kwh: 50,
      _tier_breakdown: [{ label: "T1", kwh: 50, amount: 25000 }],
      _total_amount: 25000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: {
        household_name: "BC1 Household A",
        previous_total_amount: null,
        new_total_amount: 25000,
        previous_reading_source: null,
        new_reading_source: "edge",
      },
    });
    expect(error).toBeNull();

    const { data: lis } = await svc
      .from("billing_line_items")
      .select("id, total_amount, reading_source, payment_status")
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA);
    expect(lis?.length).toBe(1);
    expect(lis?.[0]?.total_amount).toBe(25000);
    expect(lis?.[0]?.reading_source).toBe("edge");
    expect(lis?.[0]?.payment_status).toBe("unpaid");

    const { data: audits } = await svc
      .from("billing_audit_log")
      .select("event_type, actor_user_id, billing_line_item_id, details")
      .eq("billing_period_id", FIXTURE.periodA)
      .order("created_at", { ascending: false })
      .limit(1);
    expect(audits?.length).toBe(1);
    expect(audits?.[0]?.event_type).toBe("line_item_generated");
    expect(audits?.[0]?.billing_line_item_id).toBe(lis?.[0]?.id);
    expect(audits?.[0]?.actor_user_id).toBe(alejandroSuperAdmin.userId);
  });

  it("fn_record_line_item_with_audit: UPDATE-via-CONFLICT preserves payment_status / paid_at / paid_by_user_id for a paid row, and writes 'line_item_regenerated'", async () => {
    const svc = await serviceClient();

    // First, mark the row paid via fn_apply_payment_event so the CHECK
    // constraint is satisfied (paid → paid_at + paid_by_user_id non-null).
    const { data: existing } = await svc
      .from("billing_line_items")
      .select("id")
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA)
      .single<{ id: string }>();
    const lineItemId = existing!.id;

    await svc.rpc("fn_apply_payment_event", {
      _line_item_id: lineItemId,
      _to_status: "paid",
      _source: "manual",
      _actor_user_id: alejandroSuperAdmin.userId,
      _raw_payload: { payment_notes: "cash collected" },
    });

    const { data: paidBefore } = await svc
      .from("billing_line_items")
      .select("payment_status, paid_at, paid_by_user_id, payment_notes")
      .eq("id", lineItemId)
      .single<{
        payment_status: string;
        paid_at: string | null;
        paid_by_user_id: string | null;
        payment_notes: string | null;
      }>();
    expect(paidBefore?.payment_status).toBe("paid");
    expect(paidBefore?.paid_at).toBeTruthy();
    expect(paidBefore?.paid_by_user_id).toBe(alejandroSuperAdmin.userId);

    const { count: peCountBefore } = await svc
      .from("payment_events")
      .select("*", { count: "exact", head: true })
      .eq("line_item_id", lineItemId);

    // Now regenerate via fn_record_line_item_with_audit — UPSERT-UPDATE
    // path. Payment fields MUST be untouched.
    const { error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 80,
      _start_kwh: 0,
      _end_kwh: 80,
      _tier_breakdown: [{ label: "T1", kwh: 80, amount: 40000 }],
      _total_amount: 40000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: {
        household_name: "BC1 Household A",
        previous_total_amount: 25000,
        new_total_amount: 40000,
        previous_reading_source: "edge",
        new_reading_source: "edge",
      },
    });
    expect(error).toBeNull();

    const { data: paidAfter } = await svc
      .from("billing_line_items")
      .select("id, payment_status, paid_at, paid_by_user_id, total_amount, payment_notes")
      .eq("id", lineItemId)
      .single<{
        id: string;
        payment_status: string;
        paid_at: string | null;
        paid_by_user_id: string | null;
        total_amount: number;
        payment_notes: string | null;
      }>();
    expect(paidAfter?.id).toBe(lineItemId); // SAME row, not a new one.
    expect(paidAfter?.payment_status).toBe("paid");
    expect(paidAfter?.paid_at).toBe(paidBefore?.paid_at);
    expect(paidAfter?.paid_by_user_id).toBe(paidBefore?.paid_by_user_id);
    expect(paidAfter?.payment_notes).toBe(paidBefore?.payment_notes);
    expect(paidAfter?.total_amount).toBe(40000); // recalc landed

    // payment_events history NOT cascaded away.
    const { count: peCountAfter } = await svc
      .from("payment_events")
      .select("*", { count: "exact", head: true })
      .eq("line_item_id", lineItemId);
    expect(peCountAfter).toBe(peCountBefore);

    // The latest audit row is line_item_regenerated.
    const { data: lastAudit } = await svc
      .from("billing_audit_log")
      .select("event_type")
      .eq("billing_period_id", FIXTURE.periodA)
      .order("created_at", { ascending: false })
      .limit(1);
    expect(lastAudit?.[0]?.event_type).toBe("line_item_regenerated");
  });

  it("fn_record_line_item_with_audit: appends details.period_was_closed=true when period is closed", async () => {
    const svc = await serviceClient();

    // Flip period A to closed.
    await svc
      .from("billing_periods")
      .update({ status: "closed", closed_at: new Date().toISOString() })
      .eq("id", FIXTURE.periodA);

    const { error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 90,
      _start_kwh: 0,
      _end_kwh: 90,
      _tier_breakdown: [{ label: "T1", kwh: 90, amount: 45000 }],
      _total_amount: 45000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: {
        household_name: "BC1 Household A",
        previous_total_amount: 40000,
        new_total_amount: 45000,
        previous_reading_source: "edge",
        new_reading_source: "edge",
      },
    });
    expect(error).toBeNull();

    const { data: lastAudit } = await svc
      .from("billing_audit_log")
      .select("details")
      .eq("billing_period_id", FIXTURE.periodA)
      .order("created_at", { ascending: false })
      .limit(1);
    const details = lastAudit?.[0]?.details as Record<string, unknown>;
    expect(details?.period_was_closed).toBe(true);

    // Reset for downstream tests.
    await svc
      .from("billing_periods")
      .update({ status: "draft", closed_at: null })
      .eq("id", FIXTURE.periodA);
  });

  // ── #217 / 00037 — payment-link auto-invalidation on amount change ────────
  //
  // Each case uses a distinct household so the post-state on one case does
  // not contaminate the next. The seed for each case is INSERT-via-RPC for
  // the `total_amount` baseline, then a direct UPDATE on the row to plant
  // the cached payment fields (payment_status / paid_at / paid_by_user_id /
  // pesapal_redirect_url / pesapal_order_id / payment_failed_at). The
  // direct UPDATE bypasses the state machine deliberately — the fixture is
  // simulating a row that has accumulated payment cache via past flows; the
  // test focuses on what happens when `fn_record_line_item_with_audit` runs
  // a re-key.

  it("00037 / #217 (Case A): UPSERT-UPDATE NULLs pesapal_redirect_url + pesapal_order_id + payment_failed_at when amount changes (unpaid row)", async () => {
    const svc = await serviceClient();

    // Seed: insert via RPC at total_amount=1000 then plant the payment cache.
    await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA_inv1,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 10,
      _start_kwh: 0,
      _end_kwh: 10,
      _tier_breakdown: [{ label: "T1", kwh: 10, amount: 1000 }],
      _total_amount: 1000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: { household_name: "BC1 Household A-inv1" },
    });
    const failedAt = new Date().toISOString();
    await svc
      .from("billing_line_items")
      .update({
        pesapal_redirect_url: "https://pesapal.test/A",
        pesapal_order_id: "ord-A",
        payment_failed_at: failedAt,
        // payment_status remains 'unpaid' (default)
      })
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA_inv1);

    // Re-key with a different total_amount.
    const { error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA_inv1,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 15,
      _start_kwh: 0,
      _end_kwh: 15,
      _tier_breakdown: [{ label: "T1", kwh: 15, amount: 1500 }],
      _total_amount: 1500,
      _reading_source: "manual",
      _entered_by_user_id: alejandroSuperAdmin.userId,
      _manual_reason: "operator correction",
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: { household_name: "BC1 Household A-inv1" },
    });
    expect(error).toBeNull();

    const { data: after } = await svc
      .from("billing_line_items")
      .select(
        "total_amount, pesapal_redirect_url, pesapal_order_id, payment_failed_at, payment_status",
      )
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA_inv1)
      .single<{
        total_amount: number;
        pesapal_redirect_url: string | null;
        pesapal_order_id: string | null;
        payment_failed_at: string | null;
        payment_status: string;
      }>();

    expect(Number(after?.total_amount)).toBe(1500);
    expect(after?.pesapal_redirect_url).toBeNull();
    expect(after?.pesapal_order_id).toBeNull();
    expect(after?.payment_failed_at).toBeNull();
    expect(after?.payment_status).toBe("unpaid");
  });

  it("00037 / #217 (Case B): UPSERT-UPDATE preserves pesapal_redirect_url + pesapal_order_id + payment_failed_at when amount is unchanged", async () => {
    const svc = await serviceClient();

    await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA_inv2,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 20,
      _start_kwh: 0,
      _end_kwh: 20,
      _tier_breakdown: [{ label: "T1", kwh: 20, amount: 2000 }],
      _total_amount: 2000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: { household_name: "BC1 Household A-inv2" },
    });
    const failedAt = new Date().toISOString();
    await svc
      .from("billing_line_items")
      .update({
        pesapal_redirect_url: "https://pesapal.test/B",
        pesapal_order_id: "ord-B",
        payment_failed_at: failedAt,
      })
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA_inv2);

    // Re-run with the SAME total_amount — auto-invalidation must NOT fire.
    const { error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA_inv2,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 20,
      _start_kwh: 0,
      _end_kwh: 20,
      _tier_breakdown: [{ label: "T1", kwh: 20, amount: 2000 }],
      _total_amount: 2000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: { household_name: "BC1 Household A-inv2" },
    });
    expect(error).toBeNull();

    const { data: after } = await svc
      .from("billing_line_items")
      .select(
        "total_amount, pesapal_redirect_url, pesapal_order_id, payment_failed_at",
      )
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA_inv2)
      .single<{
        total_amount: number;
        pesapal_redirect_url: string | null;
        pesapal_order_id: string | null;
        payment_failed_at: string | null;
      }>();
    expect(Number(after?.total_amount)).toBe(2000);
    expect(after?.pesapal_redirect_url).toBe("https://pesapal.test/B");
    expect(after?.pesapal_order_id).toBe("ord-B");
    expect(after?.payment_failed_at).toBeTruthy();
  });

  it("00037 / #217 (Case C): UPSERT-UPDATE NULLs pesapal_redirect_url + pesapal_order_id on amount change but PRESERVES payment_status='paid' + paid_at + paid_by_user_id", async () => {
    const svc = await serviceClient();

    // Seed: insert via RPC at total_amount=3000 then mark paid via the
    // canonical state-machine RPC (so the audit-fields CHECK constraint is
    // satisfied), then plant pesapal_redirect_url separately.
    await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA_inv3,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 30,
      _start_kwh: 0,
      _end_kwh: 30,
      _tier_breakdown: [{ label: "T1", kwh: 30, amount: 3000 }],
      _total_amount: 3000,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: { household_name: "BC1 Household A-inv3" },
    });
    const { data: row } = await svc
      .from("billing_line_items")
      .select("id")
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA_inv3)
      .single<{ id: string }>();
    const liId = row!.id;

    await svc.rpc("fn_apply_payment_event", {
      _line_item_id: liId,
      _to_status: "paid",
      _source: "manual",
      _actor_user_id: alejandroSuperAdmin.userId,
      _raw_payload: { payment_notes: "cash collected pre-rekey" },
    });
    await svc
      .from("billing_line_items")
      .update({
        pesapal_redirect_url: "https://pesapal.test/C",
        pesapal_order_id: "ord-C",
      })
      .eq("id", liId);

    const { data: paidBefore } = await svc
      .from("billing_line_items")
      .select("payment_status, paid_at, paid_by_user_id, payment_notes")
      .eq("id", liId)
      .single<{
        payment_status: string;
        paid_at: string | null;
        paid_by_user_id: string | null;
        payment_notes: string | null;
      }>();
    expect(paidBefore?.payment_status).toBe("paid");
    expect(paidBefore?.paid_at).toBeTruthy();

    // Re-key with a different total_amount.
    const { error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA_inv3,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 35,
      _start_kwh: 0,
      _end_kwh: 35,
      _tier_breakdown: [{ label: "T1", kwh: 35, amount: 3500 }],
      _total_amount: 3500,
      _reading_source: "manual",
      _entered_by_user_id: alejandroSuperAdmin.userId,
      _manual_reason: "dispute reread",
      _actor_user_id: alejandroSuperAdmin.userId,
      _audit_details: { household_name: "BC1 Household A-inv3" },
    });
    expect(error).toBeNull();

    const { data: after } = await svc
      .from("billing_line_items")
      .select(
        "total_amount, pesapal_redirect_url, pesapal_order_id, payment_status, paid_at, paid_by_user_id, payment_notes",
      )
      .eq("id", liId)
      .single<{
        total_amount: number;
        pesapal_redirect_url: string | null;
        pesapal_order_id: string | null;
        payment_status: string;
        paid_at: string | null;
        paid_by_user_id: string | null;
        payment_notes: string | null;
      }>();
    expect(Number(after?.total_amount)).toBe(3500);
    // Pesapal cache invalidated (operator must reconcile manually).
    expect(after?.pesapal_redirect_url).toBeNull();
    expect(after?.pesapal_order_id).toBeNull();
    // Past payment record permanent — survives the re-key.
    expect(after?.payment_status).toBe("paid");
    expect(after?.paid_at).toBe(paidBefore?.paid_at);
    expect(after?.paid_by_user_id).toBe(paidBefore?.paid_by_user_id);
    expect(after?.payment_notes).toBe(paidBefore?.payment_notes);
  });

  // ── Atomicity ─────────────────────────────────────────────────────────────

  it("fn_record_line_item_with_audit: failed audit insert rolls back the line item upsert", async () => {
    const svc = await serviceClient();

    // Snapshot total_amount BEFORE.
    const { data: before } = await svc
      .from("billing_line_items")
      .select("total_amount")
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA)
      .single<{ total_amount: number }>();
    const totalBefore = Number(before?.total_amount);

    // Force a constraint violation: pass an actor_user_id that doesn't exist
    // in auth.users. The audit row's FK on actor_user_id will throw, and
    // the line item upsert MUST roll back as part of the same transaction.
    const fakeActor = randomUUID();
    const { error } = await svc.rpc("fn_record_line_item_with_audit", {
      _billing_period_id: FIXTURE.periodA,
      _household_id: FIXTURE.hhA,
      _device_id: FIXTURE.deviceA,
      _usage_kwh: 999,
      _start_kwh: 0,
      _end_kwh: 999,
      _tier_breakdown: [{ label: "T1", kwh: 999, amount: 99999 }],
      _total_amount: 99999,
      _reading_source: "edge",
      _entered_by_user_id: null,
      _manual_reason: null,
      _actor_user_id: fakeActor,
      _audit_details: { household_name: "BC1 Household A" },
    });
    expect(error).toBeTruthy();

    // total_amount must be unchanged — the upsert was rolled back.
    const { data: after } = await svc
      .from("billing_line_items")
      .select("total_amount")
      .eq("billing_period_id", FIXTURE.periodA)
      .eq("household_id", FIXTURE.hhA)
      .single<{ total_amount: number }>();
    expect(Number(after?.total_amount)).toBe(totalBefore);
  });

  // ── RLS ───────────────────────────────────────────────────────────────────

  it("RLS: org_manager A can SELECT their own org's billing_audit_log entries", async () => {
    const { data, error } = await aaronOrgManagerA.client
      .from("billing_audit_log")
      .select("id, event_type")
      .eq("billing_period_id", FIXTURE.periodA);
    expect(error).toBeNull();
    expect((data?.length ?? 0)).toBeGreaterThan(0);
  });

  it("RLS: org_manager A cannot SELECT org B's billing_audit_log entries", async () => {
    // First seed an audit row for orgB via the service client.
    const svc = await serviceClient();
    await svc.from("billing_audit_log").insert({
      billing_period_id: FIXTURE.periodB,
      event_type: "period_created",
      actor_user_id: bobOrgManagerB.userId,
      details: { household_name: "BC1 Household B" },
    });

    const { data, error } = await aaronOrgManagerA.client
      .from("billing_audit_log")
      .select("id")
      .eq("billing_period_id", FIXTURE.periodB);
    // RLS hides the row — we get 0 rows, no error.
    expect(error).toBeNull();
    expect(data?.length ?? 0).toBe(0);
  });

  it("RLS: super_admin sees both orgs' billing_audit_log entries", async () => {
    const { data: dataA } = await alejandroSuperAdmin.client
      .from("billing_audit_log")
      .select("id")
      .eq("billing_period_id", FIXTURE.periodA);
    const { data: dataB } = await alejandroSuperAdmin.client
      .from("billing_audit_log")
      .select("id")
      .eq("billing_period_id", FIXTURE.periodB);
    expect((dataA?.length ?? 0)).toBeGreaterThan(0);
    expect((dataB?.length ?? 0)).toBeGreaterThan(0);
  });

  it("RLS: UPDATE billing_audit_log is denied for everyone (no policy + no GRANT)", async () => {
    // Try as super_admin: still denied because there's NO update policy.
    const { data: rows } = await alejandroSuperAdmin.client
      .from("billing_audit_log")
      .select("id")
      .eq("billing_period_id", FIXTURE.periodA)
      .limit(1);
    const targetId = rows?.[0]?.id;
    expect(targetId).toBeTruthy();

    const { data: updated, error: updateErr } = await alejandroSuperAdmin.client
      .from("billing_audit_log")
      .update({ details: { tampered: true } })
      .eq("id", targetId!)
      .select();
    // Either an explicit denial OR an empty result (Postgres returns 0 rows
    // updated when the RLS WITH CHECK / USING fails). Both prove no UPDATE
    // happened.
    if (updateErr) {
      expect(String(updateErr.message)).toMatch(/permission|denied|policy/i);
    } else {
      expect(updated?.length ?? 0).toBe(0);
    }
  });

  it("RLS: DELETE billing_audit_log is denied for everyone (no policy + no GRANT)", async () => {
    const { data: rows } = await alejandroSuperAdmin.client
      .from("billing_audit_log")
      .select("id")
      .eq("billing_period_id", FIXTURE.periodA)
      .limit(1);
    const targetId = rows?.[0]?.id;
    expect(targetId).toBeTruthy();

    const { data: deleted, error: delErr } = await alejandroSuperAdmin.client
      .from("billing_audit_log")
      .delete()
      .eq("id", targetId!)
      .select();
    if (delErr) {
      expect(String(delErr.message)).toMatch(/permission|denied|policy/i);
    } else {
      expect(deleted?.length ?? 0).toBe(0);
    }
  });
});
