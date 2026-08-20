/**
 * generate-unmetered-skip.test.ts (#293)
 *
 * Pull-mode (`householdIds === undefined`) guardrail: an un-metered household
 * with no manual reading and no OpenEMS data must be SKIPPED and reported —
 * NOT written as a silent zeroed placeholder line item.
 *
 * Before #293 the implicit-bulk `else` branch of runGenerationFor wrote a
 * placeholder row (start_kwh=0, end_kwh=0, usage_kwh=0) for such a household.
 * Pull-mode is an unattended cron, so that silently mis-billed an un-metered
 * household as service-charge-only. The fix skips the tenant and surfaces it
 * in the response with `code:"unmetered_no_manual"` — the same shape the
 * explicit dashboard path already emitted.
 *
 * Harness: unlike the precision suite in `generate.test.ts`, this test mocks
 * the Supabase client rather than driving a live local DB. The un-metered
 * pull-mode path is small enough to mock cleanly (period + schedule +
 * households + existing line items; no RPC, no OpenEMS call because the
 * household resolves to no device), so this suite runs under
 * `SKIP_RLS_TESTS=1` and gives executable coverage of the fix. The critical
 * assertion — that NO write RPC fires — is verified via a spy on
 * `supabase.rpc`.
 */

import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runGenerationFor, isRunGenerationFatal } from "@/lib/billing/generate";

const MICROGRID_ID = "aaaaaaaa-aaaa-4000-8000-000000000001";
const PERIOD_ID = "aaaaaaaa-aaaa-4000-8006-000000000001";
const HH_UNMETERED = "aaaaaaaa-aaaa-4000-8005-000000000001";

/**
 * Minimal chainable + thenable Supabase query stub. Chain methods return the
 * same builder; the terminal `.single()` / `.maybeSingle()` and `await`
 * (thenable) resolve to a per-table canned response.
 */
function makeSupabase() {
  const rpc = vi.fn(async () => ({ data: null, error: null }));

  const responses: Record<
    string,
    { single?: unknown; maybeSingle?: unknown; list?: unknown }
  > = {
    billing_periods: {
      single: {
        data: {
          id: PERIOD_ID,
          microgrid_id: MICROGRID_ID,
          start_date: "2026-04-01",
          end_date: "2026-04-30",
          status: "draft",
        },
        error: null,
      },
      // Prior-period lookup is skipped for un-metered households (no device),
      // but provide an empty list defensively.
      list: { data: [], error: null },
    },
    rate_schedules: {
      maybeSingle: {
        data: {
          microgrid_id: MICROGRID_ID,
          tiers: [
            { label: "T1", min_kwh: 0, max_kwh: null, rate_per_kwh: 100 },
          ],
          service_charge: 0,
          tax_rate: 0,
        },
        error: null,
      },
    },
    households: {
      // One household on the microgrid with NO primary_consumption_meter
      // device link — i.e. un-metered.
      list: {
        data: [
          {
            id: HH_UNMETERED,
            display_name: "Unmetered Household",
            household_devices: [],
          },
        ],
        error: null,
      },
    },
    billing_line_items: {
      // No prior line items in this period.
      list: { data: [], error: null },
    },
  };

  function builder(table: string) {
    const resp = responses[table] ?? { list: { data: [], error: null } };
    const b: Record<string, unknown> = {};
    const chain = () => b;
    for (const m of [
      "select",
      "eq",
      "neq",
      "lte",
      "gte",
      "in",
      "not",
      "order",
      "limit",
    ]) {
      b[m] = chain;
    }
    b.single = async () => resp.single ?? { data: null, error: null };
    b.maybeSingle = async () =>
      resp.maybeSingle ?? { data: null, error: null };
    // Thenable: `await builder` resolves to the list response.
    b.then = (
      onFulfilled: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown
    ) =>
      Promise.resolve(resp.list ?? { data: [], error: null }).then(
        onFulfilled,
        onRejected
      );
    return b;
  }

  const supabase = {
    from: (table: string) => builder(table),
    rpc,
  } as unknown as SupabaseClient;

  return { supabase, rpc };
}

describe("runGenerationFor: pull-mode un-metered skip (#293)", () => {
  it("write mode, householdIds undefined, un-metered household → skips with unmetered_no_manual and writes NO row", async () => {
    const { supabase, rpc } = makeSupabase();

    const out = await runGenerationFor({
      supabase,
      periodId: PERIOD_ID,
      // Pull-mode: no householdIds, no manualReadings.
      householdIds: undefined,
      mode: "write",
      actorUserId: null,
      actorKind: "customerapp",
      actorRef: "cron",
    });

    if (isRunGenerationFatal(out)) {
      throw new Error(
        `runGenerationFor returned fatal ${out.status}: ${out.body.error}`
      );
    }

    const results = out.results;
    expect(results.length).toBe(1);

    const entry = results[0];
    expect(entry.kind).toBe("error");
    expect(entry.householdId).toBe(HH_UNMETERED);
    if (entry.kind === "error") {
      expect(entry.code).toBe("unmetered_no_manual");
    }

    // The critical regression: NO placeholder row is written. The write path
    // is `supabase.rpc("fn_record_line_item_with_audit", …)`.
    expect(rpc).not.toHaveBeenCalled();

    // No 'written' result of any kind.
    expect(results.some((r) => r.kind === "written")).toBe(false);
  });

  it("preview mode, householdIds undefined, un-metered household → still reports the skip (no preview row)", async () => {
    const { supabase, rpc } = makeSupabase();

    const out = await runGenerationFor({
      supabase,
      periodId: PERIOD_ID,
      householdIds: undefined,
      mode: "preview",
      actorUserId: null,
    });

    if (isRunGenerationFatal(out)) {
      throw new Error(
        `runGenerationFor returned fatal ${out.status}: ${out.body.error}`
      );
    }

    const results = out.results;
    expect(results.length).toBe(1);
    expect(results[0].kind).toBe("error");
    if (results[0].kind === "error") {
      expect(results[0].code).toBe("unmetered_no_manual");
    }
    // Preview never writes anyway, but assert no preview placeholder row.
    expect(results.some((r) => r.kind === "preview")).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });
});
