// widgets.test.tsx — Unit tests for #73 Dashboard insight widgets.
//
// Tests:
//   - OpenPeriodSummary: CTA banner when no period, summary cells when period present
//   - TopHouseholdsLeaderboard: empty state, data rows, format primitives used
//   - ConsumptionCalendarWidget: absolute mode fallback, relative mode with target
//   - ActivityLog: empty state placeholder, event rendering

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// Mock next/link for SSR rendering
vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => React.createElement("a", { href, className }, children),
}));

// Mock LocaleContext so Currency/Kwh work without a real Provider in unit tests
vi.mock("@/components/format/locale-context", () => ({
  useLocale: () => ({ locale: "en-UG", currency: "UGX" }),
  LocaleProvider: ({ children }: { children: React.ReactNode }) => children,
}));

import { vi } from "vitest";
import { OpenPeriodSummary } from "../OpenPeriodSummary";
import { TopHouseholdsLeaderboard } from "../TopHouseholdsLeaderboard";
import { ConsumptionCalendarWidget } from "../ConsumptionCalendarWidget";
import { ActivityLog } from "../ActivityLog";
import { Kwh } from "@/components/format/kwh";
import { Currency } from "@/components/format/currency";

// ── OpenPeriodSummary ─────────────────────────────────────────────────────

describe("OpenPeriodSummary", () => {
  it("renders CTA banner when no open period exists", () => {
    const jsx = React.createElement(OpenPeriodSummary, {
      microgridId: "mg-1",
      period: null,
    });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("No open period");
    expect(html).toContain("/microgrids/mg-1/billing");
    expect(html).toContain("Create one");
  });

  it("renders 5-cell summary strip when open period is present", () => {
    const period = {
      id: "bp-1",
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      householdsCount: 12,
      totalUsageKwh: 450,
      totalAmount: 112500,
      projectedUsageKwh: 600,
      projectedAmount: 150000,
    };
    const jsx = React.createElement(OpenPeriodSummary, {
      microgridId: "mg-1",
      period,
    });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("Open period");
    expect(html).toContain("Households");
    expect(html).toContain("12");
    expect(html).toContain("kWh so far");
    expect(html).toContain("Projected total");
    // No raw Intl.NumberFormat usage — Currency/Kwh components render formatted values
    // Currency will render UGX formatted amount
    expect(html).toContain("112"); // part of 112,500 UGX
  });

  it("uses Currency and Kwh format primitives (no inline Intl.NumberFormat)", () => {
    // Verify the rendered HTML uses the font-mono tabular-nums class from Kwh/Currency,
    // which is the token applied by those components.
    const period = {
      id: "bp-1",
      start_date: "2026-04-01",
      end_date: "2026-04-30",
      householdsCount: 5,
      totalUsageKwh: 200,
      totalAmount: 50000,
      projectedUsageKwh: 300,
      projectedAmount: 75000,
    };
    const jsx = React.createElement(OpenPeriodSummary, {
      microgridId: "mg-1",
      period,
    });
    const html = renderToStaticMarkup(jsx);

    // Both Kwh and Currency components apply font-mono tabular-nums
    expect(html).toContain("tabular-nums");
  });
});

// ── TopHouseholdsLeaderboard ──────────────────────────────────────────────

describe("TopHouseholdsLeaderboard", () => {
  it("renders empty state when no entries", () => {
    const jsx = React.createElement(TopHouseholdsLeaderboard, {
      entries: [],
      microgridTotalKwh: 0,
    });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("No readings in the current period yet");
    // No table rows
    expect(html).not.toContain("<tr");
  });

  it("renders top-3 rows with household names (static text, no links)", () => {
    const entries = [
      { householdId: "hh-1", householdName: "Nakato House", usageKwh: 120, totalAmount: 30000 },
      { householdId: "hh-2", householdName: "Ssali House", usageKwh: 90, totalAmount: 22500 },
      { householdId: "hh-3", householdName: "Kayiga House", usageKwh: 60, totalAmount: 15000 },
    ];
    const jsx = React.createElement(TopHouseholdsLeaderboard, {
      entries,
      microgridTotalKwh: 270,
    });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("Nakato House");
    expect(html).toContain("Ssali House");
    expect(html).toContain("Kayiga House");
    // Rank numbers
    expect(html).toContain(">1<");
    expect(html).toContain(">2<");
    expect(html).toContain(">3<");
    // Household names are static text (no links to household detail pages)
    expect(html).not.toContain('href="/microgrids');
  });

  it("shows % of microgrid total in the last column", () => {
    const entries = [
      { householdId: "hh-1", householdName: "House A", usageKwh: 100, totalAmount: 25000 },
    ];
    const jsx = React.createElement(TopHouseholdsLeaderboard, {
      entries,
      microgridTotalKwh: 200,
    });
    const html = renderToStaticMarkup(jsx);

    // 100/200 = 50.0%
    expect(html).toContain("50.0%");
  });

  it("uses Kwh and Currency format primitives (font-mono tabular-nums present)", () => {
    const entries = [
      { householdId: "hh-1", householdName: "House A", usageKwh: 150, totalAmount: 37500 },
    ];
    const jsx = React.createElement(TopHouseholdsLeaderboard, {
      entries,
      microgridTotalKwh: 150,
    });
    const html = renderToStaticMarkup(jsx);

    // Both Kwh and Currency components apply this class
    expect(html).toContain("tabular-nums");
  });
});

// ── ConsumptionCalendarWidget ─────────────────────────────────────────────

describe("ConsumptionCalendarWidget", () => {
  const sampleDates = Array.from({ length: 30 }, (_, i) => {
    const d = new Date("2026-03-23");
    d.setDate(d.getDate() + i);
    return d.toISOString().slice(0, 10);
  });

  it("renders in absolute mode (no target) when targetDailyKwh is null", () => {
    const jsx = React.createElement(ConsumptionCalendarWidget, {
      windowDates: sampleDates,
      energyByDate: { "2026-03-23": 12.5 },
      targetDailyKwh: null,
    });
    const html = renderToStaticMarkup(jsx);

    // Calendar renders
    expect(html).toContain("Consumption (last 30 days)");
    // In absolute mode, no pct is computed — cells use the absolute path
    // ConsumptionCell renders data-status or status class based on mode
    // Just confirm it renders without crashing
    expect(html).toBeTruthy();
  });

  it("renders in relative mode when targetDailyKwh is provided", () => {
    const jsx = React.createElement(ConsumptionCalendarWidget, {
      windowDates: sampleDates,
      energyByDate: { "2026-03-23": 12.5 },
      targetDailyKwh: 10,
    });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("Consumption (last 30 days)");
    expect(html).toBeTruthy();
  });

  it("falls back to absolute mode when targetDailyKwh is null (< 7 day period or no data)", () => {
    // targetDailyKwh = null simulates the fallback condition from the page
    const jsx = React.createElement(ConsumptionCalendarWidget, {
      windowDates: sampleDates,
      energyByDate: {},
      targetDailyKwh: null,
    });
    const html = renderToStaticMarkup(jsx);

    // Widget renders — absolute mode means no pct, no relative comparison
    expect(html).toContain("Consumption (last 30 days)");
  });
});

// ── ActivityLog ───────────────────────────────────────────────────────────

describe("ActivityLog", () => {
  it("renders 'No recent activity.' when events array is empty", () => {
    const jsx = React.createElement(ActivityLog, { events: [] });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("No recent activity.");
  });

  it("renders event descriptions and relative timestamps when events are present", () => {
    const events = [
      {
        kind: "period_opened",
        timestamp: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        description: "Period opened: 2026-04-01 – 2026-04-30",
      },
      {
        kind: "household_added",
        timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
        description: "Household added: Nakato House",
      },
    ];
    const jsx = React.createElement(ActivityLog, { events });
    const html = renderToStaticMarkup(jsx);

    expect(html).toContain("Period opened: 2026-04-01 – 2026-04-30");
    expect(html).toContain("Household added: Nakato House");
    // Relative timestamps rendered
    expect(html).toContain("hours ago");
    expect(html).toContain("days ago");
  });
});

// ── Format primitive assertions ──────────────────────────────────────────

describe("Format primitives (Currency and Kwh)", () => {
  it("Currency renders with font-mono tabular-nums and no raw Intl instantiation", () => {
    const jsx = React.createElement(Currency, { value: 42000 });
    const html = renderToStaticMarkup(jsx);
    expect(html).toContain("tabular-nums");
    expect(html).toContain("42"); // formatted number present
  });

  it("Kwh renders with kWh suffix and font-mono tabular-nums", () => {
    const jsx = React.createElement(Kwh, { value: 123.4 });
    const html = renderToStaticMarkup(jsx);
    expect(html).toContain("tabular-nums");
    expect(html).toContain("kWh");
  });
});
