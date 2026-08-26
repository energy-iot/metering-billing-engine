/**
 * seed-reading.test.ts — #339.
 *
 * `startKwh` for an edge-metered household has three sources and no zero
 * default. This file exercises all three against a real database, because the
 * defect being fixed was a fallback that produced a *plausible* value rather
 * than an error, and a mocked-everything test would have passed over it.
 *
 *   1. prior MBE `end_kwh` for the device — the running tally
 *   2. an operator seed — the meter was billed before it was connected
 *   3. neither → refuse with `needs_seed_reading`, write nothing
 *
 * OpenEMS is mocked (usage is not what is under test); Supabase is real, and
 * `runGenerationFor` takes the client as a parameter so no module patching is
 * needed for it.
 *
 * Opt-out: SKIP_RLS_TESTS=1 for running without a local Supabase. Since #324
 * the merge gate does NOT set that flag — these run on every PR.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
  assertEnvironmentReady,
  shouldSkip,
  serviceClient,
  cleanupTestData,
  createTestUser,
} from "@/lib/supabase/__tests__/rls.helpers";
import { isRunGenerationFatal } from "../generate";

const USAGE_KWH = 214;

// The edge path calls getEdgesStatus + a usage query through this factory.
// Mocked at module scope: the subject is which `start_kwh` is chosen, not how
// usage is obtained.
vi.mock("@/lib/openems", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openems")>(
    "@/lib/openems"
  );
  return {
    ...actual,
    createOpenEmsClient: () => ({
      getReadings: async (
        devices: { id: string }[],
        startDate: string,
        endDate: string,
        _timezone: string
      ) =>
        devices.map((d) => ({
          deviceId: d.id,
          usageKwh: USAGE_KWH,
          startDate,
          endDate,
        })),
    }),
  };
});

const skip = shouldSkip();
const desc = skip ? describe.skip : describe;

if (skip) {
  console.log("[seed-reading.test] SKIP_RLS_TESTS=1 — skipping suite.");
}

const F = {
  org: "5eed0000-0000-4000-8000-000000000001",
  comm: "5eed0000-0000-4000-8001-000000000001",
  mg: "5eed0000-0000-4000-8002-000000000001",
  edge: "5eed0000-0000-4000-8003-000000000001",
  device: "5eed0000-0000-4000-8004-000000000001",
  hh: "5eed0000-0000-4000-8005-000000000001",
  period: "5eed0000-0000-4000-8006-000000000001",
};

const EMAIL = `seed339-super-${Date.now()}@test.local`;

let sa: {
  userId: string;
  jwt: string;
  client: import("@supabase/supabase-js").SupabaseClient;
};

desc("#339 — start_kwh has three sources and no zero default", () => {
  beforeAll(async () => {
    await assertEnvironmentReady();
    const svc = await serviceClient();
    await cleanupTestData({ orgIds: [F.org], userEmails: [EMAIL] });

    // Supabase returns { error } rather than throwing, so an unchecked insert
    // fails silently and the failure surfaces later as something unrelated —
    // this fixture first reported "Billing period not found". Assert each one.
    const ins = async (table: string, row: Record<string, unknown>) => {
      const { error } = await svc.from(table).insert(row);
      if (error) throw new Error(`[seed-reading fixture] ${table}: ${error.message}`);
    };

    await ins("organizations", { id: F.org, name: "Seed Org" });
    await ins("communities", { id: F.comm, org_id: F.org, name: "Seed Community" });
    await ins("microgrids", {
      id: F.mg,
      community_id: F.comm,
      name: "Seed Microgrid",
      currency: "UGX",
      ems_type: "direct_url",
      ems_backend_url: "https://ems.invalid/rest",
    });
    await ins("rate_schedules", {
      microgrid_id: F.mg,
      tiers: [{ label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 100 }],
      service_charge: 0,
      tax_rate: 0,
    });
    await ins("edges", {
      id: F.edge,
      microgrid_id: F.mg,
      name: "Edge 0",
      openems_edge_id: "edge0",
    });
    await ins("devices", {
      id: F.device,
      edge_id: F.edge,
      name: "Seed Meter",
      device_type: "consumption_meter",
      openems_component_id: "meter0",
    });
    await ins("households", {
      id: F.hh,
      microgrid_id: F.mg,
      display_name: "Seed Household",
      primary_phone: "+256700000001",
    });
    // The household↔device link is the many-to-many join, not a column on
    // households (post-AB #50).
    await ins("household_devices", {
      household_id: F.hh,
      device_id: F.device,
      role: "primary_consumption_meter",
    });
    await ins("billing_periods", {
      id: F.period,
      microgrid_id: F.mg,
      start_date: "2026-08-01",
      end_date: "2026-08-31",
      status: "draft",
    });

    sa = await createTestUser({ email: EMAIL, role: "super_admin", scopeId: null });
  }, 60_000);

  afterAll(async () => {
    await cleanupTestData({ orgIds: [F.org], userEmails: [EMAIL] });
  });

  async function generate(seedReadings?: {
    deviceId: string;
    dialReadingKwh: number;
    readAt: string;
    startKwh: number;
  }[]) {
    const { runGenerationFor } = await import("../generate");
    const svc = await serviceClient();
    const out = await runGenerationFor({
      supabase: svc,
      periodId: F.period,
      mode: "preview",
      actorUserId: sa.userId,
      seedReadings,
    });
    // A fatal here means the fixture is wrong, not that the behaviour under
    // test failed — surface it as such rather than as a confusing assertion
    // mismatch three lines later. That is how a mistyped `periodId` first
    // presented as "expected false to be true".
    if (isRunGenerationFatal(out)) {
      throw new Error(`generation fatal: ${JSON.stringify(out.body)}`);
    }
    return out;
  }

  it("refuses when there is no prior reading and no seed", async () => {
    const out = await generate();
    const errs = out.results.filter((r) => r.kind === "error");

    // The whole point: no line, not a zero.
    expect(errs.some((e) => e.code === "needs_seed_reading")).toBe(true);
    const written = out.results.filter(
      (r) => r.kind !== "error" && r.householdId === F.hh
    );
    expect(written).toHaveLength(0);
  });

  it("uses an operator seed when one is supplied", async () => {
    const out = await generate([
      {
        deviceId: F.device,
        dialReadingKwh: 4196,
        readAt: "2026-08-20T09:00:00Z",
        startKwh: 3982,
      },
    ]);

    const row = out.results.find((r) => r.householdId === F.hh) as
      | { kind: string; startKwh?: number; endKwh?: number }
      | undefined;

    expect(row?.kind).not.toBe("error");
    expect(Number(row?.startKwh)).toBe(3982);
    // The pair must still add up — this is what a customer checks.
    expect(Number(row?.endKwh)).toBe(3982 + USAGE_KWH);
  });

  it("prefers a prior MBE reading over a seed when both exist", async () => {
    const svc = await serviceClient();
    const insHere = async (table: string, row: Record<string, unknown>) => {
      const { error } = await svc.from(table).insert(row);
      if (error) throw new Error(`[seed-reading] ${table}: ${error.message}`);
    };
    const priorPeriod = "5eed0000-0000-4000-8006-000000000002";
    await insHere("billing_periods", {
      id: priorPeriod,
      microgrid_id: F.mg,
      start_date: "2026-07-01",
      end_date: "2026-07-31",
      status: "closed",
    });
    await insHere("billing_line_items", {
      billing_period_id: priorPeriod,
      household_id: F.hh,
      device_id: F.device,
      start_kwh: 4000,
      end_kwh: 4100,
      usage_kwh: 100,
      total_amount: 0,
    });

    const out = await generate([
      {
        deviceId: F.device,
        dialReadingKwh: 9999,
        readAt: "2026-08-20T09:00:00Z",
        startKwh: 1,
      },
    ]);

    const row = out.results.find((r) => r.householdId === F.hh) as
      | { startKwh?: number }
      | undefined;

    // The tally is authoritative once it exists; a seed is only for the gap.
    expect(Number(row?.startKwh)).toBe(4100);
  });
});
