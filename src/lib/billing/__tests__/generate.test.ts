/**
 * generate.test.ts (#227)
 *
 * Validates that `runGenerationFor` rounds reading-side numerics before
 * passing them to the RPC (write mode) and before pushing to the preview
 * payload (preview mode). The Peter Ntale fixture (start_kwh = 83.570,
 * end_kwh = 261.92 → usage_kwh = 178.35000000000002 in IEEE-754) is the
 * primary regression seed.
 *
 * Harness: same local-Supabase-CLI pattern as
 * `src/lib/supabase/__tests__/billing_audit_log.test.ts`. Skips
 * automatically when `SKIP_RLS_TESTS=1` or `SUPABASE_JWT_SECRET` is
 * missing. Rationale: mocking the full Supabase chain that
 * runGenerationFor traverses (periods, schedules, households,
 * line_items, devices, RPC) is ~150 LoC of stubs — leveraging the live
 * local DB is simpler AND exercises the SQL+TS rounding together.
 *
 * Fixture isolation: uses its own org/community/microgrid/household/
 * period to avoid contamination from billing_audit_log.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
} from "@/lib/supabase/__tests__/rls.helpers";

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[generate.test] SKIP_RLS_TESTS=1 — skipping suite.");
}

const FIXTURE = {
  // Org/community/microgrid for the precision suite — un-metered
  // household so runGenerationFor routes through the manual-override
  // path without contacting OpenEMS.
  orgP: "dddddddd-dddd-4000-8000-00000000000d",
  commP: "dddddddd-dddd-4000-8001-00000000000d",
  mgP: "dddddddd-dddd-4000-8002-00000000000d",
  hhP: "dddddddd-dddd-4000-8005-00000000000d",
  periodP: "dddddddd-dddd-4000-8006-00000000000d",
  periodP2: "dddddddd-dddd-4000-8006-00000000001d",
};

let alejandroSuperAdmin: {
  userId: string;
  jwt: string;
  client: import("@supabase/supabase-js").SupabaseClient;
};

const EMAIL_SUPER = `gen227-super-${Date.now()}@test.local`;

desc("runGenerationFor: precision rounding (#227)", () => {
  beforeAll(async () => {
    if (skip) return;
    await assertEnvironmentReady();
    const svc = await serviceClient();

    await cleanupTestData({
      orgIds: [FIXTURE.orgP],
      userEmails: [EMAIL_SUPER],
    });

    // Un-metered household setup — runGenerationFor's manual-override
    // path is exercised so we don't need OpenEMS config.
    await svc.from("organizations").insert({ id: FIXTURE.orgP, name: "227 Org P" });
    await svc.from("communities").insert({
      id: FIXTURE.commP,
      org_id: FIXTURE.orgP,
      name: "227 Comm P",
    });
    await svc.from("microgrids").insert({
      id: FIXTURE.mgP,
      community_id: FIXTURE.commP,
      name: "227 MG P",
      currency: "UGX",
    });
    // Single tier at 100 UGX/kWh — Peter Ntale usage 178.35 × 100 = 17835.
    await svc.from("rate_schedules").insert({
      microgrid_id: FIXTURE.mgP,
      tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 100 }],
      service_charge: 0,
      tax_rate: 0,
    });
    await svc.from("households").insert({
      id: FIXTURE.hhP,
      microgrid_id: FIXTURE.mgP,
      display_name: "227 Peter Ntale",
      primary_phone: "+256700000099",
    });
    await svc.from("billing_periods").insert({
      id: FIXTURE.periodP,
      microgrid_id: FIXTURE.mgP,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      status: "draft",
    });
    await svc.from("billing_periods").insert({
      id: FIXTURE.periodP2,
      microgrid_id: FIXTURE.mgP,
      start_date: "2026-05-01",
      end_date: "2026-05-31",
      status: "draft",
    });

    alejandroSuperAdmin = await createTestUser({
      email: EMAIL_SUPER,
      role: "super_admin",
    });
  }, 120_000);

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({
      orgIds: [FIXTURE.orgP],
      userEmails: [EMAIL_SUPER],
    });
  }, 60_000);

  it("write mode: rounds usage_kwh + tier values + total_amount on the Peter Ntale fixture", async () => {
    // 261.92 - 83.570 === 178.35000000000002 in IEEE-754. The route
    // accepts the dust-bearing values from the caller; the rounding
    // happens internally inside runGenerationFor before the RPC.
    const { runGenerationFor } = await import("@/lib/billing/generate");
    const out = await runGenerationFor({
      supabase: alejandroSuperAdmin.client,
      periodId: FIXTURE.periodP,
      householdIds: [FIXTURE.hhP],
      manualReadings: [
        {
          householdId: FIXTURE.hhP,
          startKwh: 83.570,
          endKwh: 261.92,
          reason: "Peter Ntale fixture",
        },
      ],
      mode: "write",
      actorUserId: alejandroSuperAdmin.userId,
    });
    if ("kind" in out && out.kind === "fatal") {
      throw new Error(
        `runGenerationFor returned fatal ${out.status}: ${out.body.error}`
      );
    }

    // Re-read the persisted row.
    const svc = await serviceClient();
    const { data: row } = await svc
      .from("billing_line_items")
      .select("usage_kwh, start_kwh, end_kwh, total_amount, tier_breakdown")
      .eq("billing_period_id", FIXTURE.periodP)
      .eq("household_id", FIXTURE.hhP)
      .single<{
        usage_kwh: number | string;
        start_kwh: number | string;
        end_kwh: number | string;
        total_amount: number | string;
        tier_breakdown: { label: string; kwh: number; amount: number }[];
      }>();

    const usage = Number(row!.usage_kwh);
    const start = Number(row!.start_kwh);
    const end = Number(row!.end_kwh);
    const total = Number(row!.total_amount);

    // Primary regression: usage exactly 178.35, NOT 178.35000000000002.
    expect(usage).toBe(178.35);
    // × 1000 defeats numeric vacuity (178.35 === 178.350 in JS).
    expect(usage * 1000).toBe(178350);
    expect(start).toBe(83.57);
    expect(end).toBe(261.92);

    // total_amount = 178.35 × 100 = 17835 — integer.
    expect(total).toBe(17835);
    expect(Number.isInteger(total)).toBe(true);

    // Tier breakdown: single tier carries all 178.35 kWh.
    expect(row!.tier_breakdown.length).toBe(1);
    const t0 = row!.tier_breakdown[0];
    expect(t0.kwh).toBe(178.35);
    expect(t0.kwh * 1000).toBe(178350);
    expect(Number.isInteger(t0.amount)).toBe(true);
    expect(t0.amount).toBe(17835);
  });

  it("preview mode: pushes rounded values to the preview payload", async () => {
    // Fresh period (periodP2) so we don't read the row written by the
    // previous test.
    const { runGenerationFor } = await import("@/lib/billing/generate");
    const out = await runGenerationFor({
      supabase: alejandroSuperAdmin.client,
      periodId: FIXTURE.periodP2,
      householdIds: [FIXTURE.hhP],
      manualReadings: [
        {
          householdId: FIXTURE.hhP,
          startKwh: 83.570,
          endKwh: 261.92,
          reason: "Peter Ntale preview",
        },
      ],
      mode: "preview",
      actorUserId: alejandroSuperAdmin.userId,
    });
    if ("kind" in out && out.kind === "fatal") {
      throw new Error(
        `runGenerationFor returned fatal ${out.status}: ${out.body.error}`
      );
    }
    const results = (out as { results: Array<Record<string, unknown>> }).results;
    const preview = results.find(
      (r) => r.householdId === FIXTURE.hhP && r.kind === "preview"
    ) as
      | {
          startKwh: number;
          endKwh: number;
          usageKwh: number;
          totalAmount: number;
          tierBreakdown: { label: string; kwh: number; amount: number }[];
        }
      | undefined;
    expect(preview).toBeTruthy();

    expect(preview!.usageKwh).toBe(178.35);
    expect(preview!.usageKwh * 1000).toBe(178350);
    expect(preview!.startKwh).toBe(83.57);
    expect(preview!.endKwh).toBe(261.92);
    expect(Number.isInteger(preview!.totalAmount)).toBe(true);
    expect(preview!.totalAmount).toBe(17835);

    expect(preview!.tierBreakdown.length).toBe(1);
    expect(preview!.tierBreakdown[0].kwh).toBe(178.35);
    expect(preview!.tierBreakdown[0].kwh * 1000).toBe(178350);
    expect(Number.isInteger(preview!.tierBreakdown[0].amount)).toBe(true);
  });
});
