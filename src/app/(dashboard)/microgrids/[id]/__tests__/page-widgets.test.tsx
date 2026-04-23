// page-widgets.test.tsx — Integration tests for #73 Dashboard insight widgets
// as composed by the MicrogridDashboardPage server component.
//
// Strategy:
//   - Mock @/lib/supabase/server, @/lib/openems, @/lib/hierarchy at module level.
//   - Call MicrogridDashboardPage() directly (async server component).
//   - Serialize JSX to HTML and assert widget rendering.
//
// Coverage:
//   AC: Calendar mode="absolute" fallback when previous period < 7 days.
//   AC: Empty activity log → "No recent activity" placeholder.
//   AC: No-open-period CTA banner renders.
//   AC: Currency and Kwh primitives used (font-mono tabular-nums present in output).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

const getEdgesStatusMock = vi.fn();
const queryDailyEnergyMock = vi.fn();
vi.mock("@/lib/openems", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openems")>(
    "@/lib/openems"
  );
  return {
    ...actual,
    getOpenEmsClient: () => ({
      getEdgesStatus: getEdgesStatusMock,
      queryDailyEnergy: queryDailyEnergyMock,
    }),
  };
});

vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: vi.fn().mockResolvedValue(true),
}));

vi.mock("@/components/forms/DeleteEntityButton", () => ({
  DeleteEntityButton: () => null,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
    title,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
    title?: string;
  }) => React.createElement("a", { href, className, title }, children),
}));

vi.mock("@/components/format/locale-context", () => ({
  useLocale: () => ({ locale: "en-UG", currency: "UGX" }),
  LocaleProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// ── Import page (after mocks) ─────────────────────────────────────────────────

import MicrogridDashboardPage from "../page";

// ── Query builder helpers ─────────────────────────────────────────────────────

/**
 * Builds a chainable Supabase query mock that terminates with returns() → data.
 * Supports: select → eq → returns
 *           select → eq → eq → order → limit → returns
 *           select → eq → limit → returns
 *           select → eq → eq → limit → returns
 */
function buildQuery(data: unknown) {
  const terminal = () => Promise.resolve({ data, error: null });
  const chain: Record<string, unknown> = {};

  const leaf = {
    returns: terminal,
    then: (resolve: (v: { data: unknown; error: null }) => unknown) =>
      Promise.resolve({ data, error: null }).then(resolve),
  };

  // Build a deeply chainable object where any method returns another chainable.
  function makeChainable(): Record<string, () => Record<string, unknown>> {
    return new Proxy({} as Record<string, () => Record<string, unknown>>, {
      get(_target, prop) {
        if (prop === "returns") return terminal;
        if (prop === "then") {
          return (resolve: (v: { data: unknown; error: null }) => unknown) =>
            Promise.resolve({ data, error: null }).then(resolve);
        }
        return () => makeChainable();
      },
    });
  }

  void chain;
  void leaf;
  return makeChainable();
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OPENEMS_EDGE = {
  id: "edge-1",
  name: "Metering Pi",
  data_source_type: "openems",
  openems_edge_id: "edge0",
  devices: [{ id: "dev-1", openems_component_id: "meter0" }],
};

const DRAFT_PERIOD = {
  id: "bp-draft",
  microgrid_id: "mg-1",
  status: "draft",
  start_date: "2026-04-01",
  end_date: "2026-04-30",
  created_at: "2026-04-01T00:00:00Z",
  closed_at: null,
};

const CLOSED_PERIOD_SHORT = {
  id: "bp-closed-short",
  microgrid_id: "mg-1",
  status: "closed",
  start_date: "2026-03-25",
  end_date: "2026-03-30", // only 6 days → triggers absolute mode fallback
  created_at: "2026-03-25T00:00:00Z",
  closed_at: "2026-03-30T12:00:00Z",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MicrogridDashboardPage — #73 widget integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEdgesStatusMock.mockResolvedValue([{ edgeId: "edge0", online: true }]);
    queryDailyEnergyMock.mockResolvedValue({});
  });

  it("renders CTA banner when no open period exists", async () => {
    // billing_periods query is called twice (open periods + closed periods).
    // We need to handle both calls. Since makeFrom always returns the same
    // data for billing_periods, use a simple approach: first call = no open,
    // second call = no closed either.
    let bpCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return buildQuery([OPENEMS_EDGE]);
      if (table === "billing_periods") {
        bpCallCount++;
        // Both draft and closed queries return empty
        return buildQuery([]);
      }
      if (table === "microgrid_recent_activity") return buildQuery([]);
      return buildQuery([]);
    });

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No open period");
    expect(html).toContain("/microgrids/mg-1/billing");
    void bpCallCount;
  });

  it("renders 'No recent activity.' when activity log is empty", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return buildQuery([OPENEMS_EDGE]);
      if (table === "billing_periods") return buildQuery([]);
      if (table === "microgrid_recent_activity") return buildQuery([]);
      return buildQuery([]);
    });

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No recent activity.");
  });

  it("renders activity log events when they exist", async () => {
    const activityEvents = [
      {
        microgrid_id: "mg-1",
        kind: "period_opened",
        timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        description: "Period opened: 2026-04-01 – 2026-04-30",
      },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return buildQuery([OPENEMS_EDGE]);
      if (table === "billing_periods") return buildQuery([]);
      if (table === "microgrid_recent_activity") return buildQuery(activityEvents);
      return buildQuery([]);
    });

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Period opened: 2026-04-01 – 2026-04-30");
  });

  it("uses Currency and Kwh format primitives — tabular-nums class present in output", async () => {
    const lineItems = [
      {
        id: "li-1",
        billing_period_id: "bp-draft",
        household_id: "hh-1",
        usage_kwh: 150,
        total_amount: 37500,
      },
    ];
    const households = [
      { id: "hh-1", display_name: "Test House", microgrid_id: "mg-1" },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return buildQuery([OPENEMS_EDGE]);
      if (table === "billing_periods") return buildQuery([DRAFT_PERIOD]);
      if (table === "billing_line_items") return buildQuery(lineItems);
      if (table === "households") return buildQuery(households);
      if (table === "microgrid_recent_activity") return buildQuery([]);
      return buildQuery([]);
    });

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Currency and Kwh both use font-mono tabular-nums
    expect(html).toContain("tabular-nums");
  });

  it("calendar mode=absolute fallback when previous period has fewer than 7 days", async () => {
    // Previous closed period is only 6 days → targetDailyKwh should be null
    // → ConsumptionCalendarWidget receives targetDailyKwh=null → absolute mode
    let bpCallCount = 0;
    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return buildQuery([OPENEMS_EDGE]);
      if (table === "billing_periods") {
        bpCallCount++;
        if (bpCallCount === 1) return buildQuery([]); // no open period
        return buildQuery([CLOSED_PERIOD_SHORT]);      // closed period < 7 days
      }
      if (table === "billing_line_items") return buildQuery([]);
      if (table === "microgrid_recent_activity") return buildQuery([]);
      return buildQuery([]);
    });

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Calendar still renders (in absolute mode — no crash, no target)
    expect(html).toContain("Consumption (last 30 days)");
    // The No-open-period CTA is also shown since there's no draft
    expect(html).toContain("No open period");
    void bpCallCount;
  });

  it("renders open period summary strip with household count and totals", async () => {
    const lineItems = [
      { id: "li-1", billing_period_id: "bp-draft", household_id: "hh-1", usage_kwh: 100, total_amount: 25000 },
      { id: "li-2", billing_period_id: "bp-draft", household_id: "hh-2", usage_kwh: 80, total_amount: 20000 },
    ];
    const households = [
      { id: "hh-1", display_name: "House A", microgrid_id: "mg-1" },
      { id: "hh-2", display_name: "House B", microgrid_id: "mg-1" },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return buildQuery([OPENEMS_EDGE]);
      if (table === "billing_periods") return buildQuery([DRAFT_PERIOD]);
      if (table === "billing_line_items") return buildQuery(lineItems);
      if (table === "households") return buildQuery(households);
      if (table === "microgrid_recent_activity") return buildQuery([]);
      return buildQuery([]);
    });

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Open period");
    expect(html).toContain("Households");
    expect(html).toContain(">2<"); // 2 households
    expect(html).toContain("Projected total");
  });

  it("top-3 leaderboard shows household names and % of total", async () => {
    const lineItems = [
      { id: "li-1", billing_period_id: "bp-draft", household_id: "hh-1", usage_kwh: 200, total_amount: 50000 },
      { id: "li-2", billing_period_id: "bp-draft", household_id: "hh-2", usage_kwh: 150, total_amount: 37500 },
      { id: "li-3", billing_period_id: "bp-draft", household_id: "hh-3", usage_kwh: 100, total_amount: 25000 },
      { id: "li-4", billing_period_id: "bp-draft", household_id: "hh-4", usage_kwh: 50, total_amount: 12500 },
    ];
    const households = [
      { id: "hh-1", display_name: "Nakato House", microgrid_id: "mg-1" },
      { id: "hh-2", display_name: "Ssali House", microgrid_id: "mg-1" },
      { id: "hh-3", display_name: "Kayiga House", microgrid_id: "mg-1" },
      { id: "hh-4", display_name: "Mugisha House", microgrid_id: "mg-1" },
    ];

    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return buildQuery([OPENEMS_EDGE]);
      if (table === "billing_periods") return buildQuery([DRAFT_PERIOD]);
      if (table === "billing_line_items") return buildQuery(lineItems);
      if (table === "households") return buildQuery(households);
      if (table === "microgrid_recent_activity") return buildQuery([]);
      return buildQuery([]);
    });

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Top 3 should be Nakato (200), Ssali (150), Kayiga (100)
    expect(html).toContain("Nakato House");
    expect(html).toContain("Ssali House");
    expect(html).toContain("Kayiga House");
    // 4th household NOT in top 3
    expect(html).not.toContain("Mugisha House");
    // % of total: 200/500 = 40.0%
    expect(html).toContain("40.0%");
  });
});
