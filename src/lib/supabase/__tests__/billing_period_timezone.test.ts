/**
 * billing_period_timezone.test.ts (#354, migration 00055)
 *
 * Verifies the timezone data model + BEFORE INSERT stamp trigger against a
 * live local Supabase:
 *
 *   1. `microgrids.timezone` and `billing_periods.timezone` exist, are
 *      readable, and default to 'UTC' when not supplied (backward-compat AC:
 *      an old-app microgrid insert that omits timezone succeeds and reads
 *      'UTC').
 *
 *   2. Stamp-on-create: inserting a billing_period on an 'Africa/Kampala'
 *      microgrid WITHOUT supplying timezone yields a row stamped
 *      'Africa/Kampala' (trg_billing_period_stamp_timezone).
 *
 *   3. No-override enforcement (mutation test): inserting a billing_period
 *      WITH a bogus explicit timezone ('Mars/OlympusMons') yields a row
 *      stamped with the microgrid's zone — the client-supplied value is
 *      discarded. This is the "no per-period override is a DB guarantee"
 *      property; it holds even for service_role, which bypasses RLS but not
 *      triggers.
 *
 *   4. Old-app write path: a billing_period insert omitting timezone on a
 *      default-'UTC' microgrid succeeds and is stamped 'UTC' (backward-compat
 *      AC on #354).
 *
 * The trigger is SECURITY INVOKER — the inserting caller reads its own
 * microgrid under RLS. These tests use the service-role client for brevity;
 * the RLS-visibility premise (period insert requires microgrid-chain access
 * under the FOR ALL policies) is covered by rls.test.ts — if billing_periods
 * ever gets verb-split policies that allow INSERT without microgrid SELECT,
 * revisit this suite.
 *
 * Honors `SKIP_RLS_TESTS=1` for local runs without Supabase (same pattern as
 * audit_actor_kind.test.ts).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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
  console.log("[billing_period_timezone] SKIP_RLS_TESTS=1 — skipping suite.");
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
      `[billing_period_timezone] fixture insert failed on ${table}: ${error.message}`,
    );
  }
}

// Deterministic fixture IDs.
const FIXTURE = {
  org: "bbbbbbbb-3540-4000-8354-000000000001",
  community: "bbbbbbbb-3540-4000-8354-000000000002",
  microgridKampala: "bbbbbbbb-3540-4000-8354-000000000003",
  microgridDefault: "bbbbbbbb-3540-4000-8354-000000000004",
  periodStamped: "bbbbbbbb-3540-4000-8354-000000000011",
  periodOverridden: "bbbbbbbb-3540-4000-8354-000000000012",
  periodOldApp: "bbbbbbbb-3540-4000-8354-000000000013",
};

desc("billing period timezone stamp trigger (#354)", () => {
  let svc: SupabaseClient;

  beforeAll(async () => {
    await assertEnvironmentReady();
    svc = await serviceClient();

    // Idempotent re-run guard: cascade-delete any leftovers from a crashed run.
    await svc.from("organizations").delete().eq("id", FIXTURE.org);

    await insertOrThrow(svc, "organizations", {
      id: FIXTURE.org,
      name: "tz-stamp-test-org",
    });
    await insertOrThrow(svc, "communities", {
      id: FIXTURE.community,
      org_id: FIXTURE.org,
      name: "tz-stamp-test-community",
    });
    await insertOrThrow(svc, "microgrids", {
      id: FIXTURE.microgridKampala,
      community_id: FIXTURE.community,
      name: "tz-stamp-test-mg-kampala",
      timezone: "Africa/Kampala",
    });
    // Deliberately omits timezone — exercises the column DEFAULT.
    await insertOrThrow(svc, "microgrids", {
      id: FIXTURE.microgridDefault,
      community_id: FIXTURE.community,
      name: "tz-stamp-test-mg-default",
    });
  });

  afterAll(async () => {
    if (skip) return;
    await cleanupTestData({ orgIds: [FIXTURE.org], userEmails: [] });
  });

  it("microgrids.timezone defaults to 'UTC' when omitted (old-app write path)", async () => {
    const { data, error } = await svc
      .from("microgrids")
      .select("timezone")
      .eq("id", FIXTURE.microgridDefault)
      .single();
    expect(error).toBeNull();
    expect(data?.timezone).toBe("UTC");
  });

  it("stamps a new period with the parent microgrid's timezone when none is supplied", async () => {
    await insertOrThrow(svc, "billing_periods", {
      id: FIXTURE.periodStamped,
      microgrid_id: FIXTURE.microgridKampala,
      start_date: "2026-08-01",
      end_date: "2026-08-31",
    });

    const { data, error } = await svc
      .from("billing_periods")
      .select("timezone")
      .eq("id", FIXTURE.periodStamped)
      .single();
    expect(error).toBeNull();
    expect(data?.timezone).toBe("Africa/Kampala");
  });

  it("discards a client-supplied timezone — no per-period override (mutation test)", async () => {
    // Bogus zone on purpose: if the trigger ever stopped overriding, this
    // would surface as 'Mars/OlympusMons', not as a silent pass.
    await insertOrThrow(svc, "billing_periods", {
      id: FIXTURE.periodOverridden,
      microgrid_id: FIXTURE.microgridKampala,
      start_date: "2026-09-01",
      end_date: "2026-09-30",
      timezone: "Mars/OlympusMons",
    });

    const { data, error } = await svc
      .from("billing_periods")
      .select("timezone")
      .eq("id", FIXTURE.periodOverridden)
      .single();
    expect(error).toBeNull();
    expect(data?.timezone).toBe("Africa/Kampala");
  });

  it("stamps 'UTC' for a period on a default-UTC microgrid (old-app insert unchanged)", async () => {
    // This is exactly the shape the current app produces (no timezone key at
    // all) — the backward-compat AC on #354.
    await insertOrThrow(svc, "billing_periods", {
      id: FIXTURE.periodOldApp,
      microgrid_id: FIXTURE.microgridDefault,
      start_date: "2026-08-01",
      end_date: "2026-08-31",
    });

    const { data, error } = await svc
      .from("billing_periods")
      .select("timezone")
      .eq("id", FIXTURE.periodOldApp)
      .single();
    expect(error).toBeNull();
    expect(data?.timezone).toBe("UTC");
  });

  it("leaves every billing_periods row outside this fixture at 'UTC' (additive backfill)", async () => {
    const { data, error } = await svc
      .from("billing_periods")
      .select("id, timezone")
      .neq("timezone", "UTC")
      .not(
        "id",
        "in",
        `(${FIXTURE.periodStamped},${FIXTURE.periodOverridden})`,
      );
    expect(error).toBeNull();
    // Only our two Kampala fixtures may be non-UTC. Anything else would mean
    // the migration backfilled or mutated pre-existing rows.
    expect(data).toEqual([]);
  });
});
