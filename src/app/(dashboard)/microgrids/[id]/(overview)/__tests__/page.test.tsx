// Microgrid Dashboard page — server component tests (UX1a / #72).
//
// Strategy:
//   - Mock @/lib/supabase/server to return fixture edge and billing-period rows.
//   - Mock @/lib/openems so getEdgesStatus yields deterministic results.
//   - Mock @/lib/hierarchy so HierarchyNav doesn't need a full Supabase chain.
//   - Call MicrogridDashboardPage() directly (async server component) and
//     serialize the returned JSX to HTML.
//   - Assert banner rendering and chip presence for each scenario.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

const getEdgesStatusMock = vi.fn();
const queryDailyEnergyMock = vi.fn().mockResolvedValue({});
vi.mock("@/lib/openems", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openems")>(
    "@/lib/openems",
  );
  return {
    ...actual,
    createOpenEmsClient: () => ({
      getEdgesStatus: getEdgesStatusMock,
      queryDailyEnergy: queryDailyEnergyMock,
    }),
  };
});

// Always return a valid ems config so the page builds a client.
vi.mock("@/lib/openems/config", () => ({
  getMicrogridEmsConfig: vi
    .fn()
    .mockResolvedValue({ type: "direct_url", url: "http://localhost:8075" }),
}));

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

// ── Import page (after mocks) ─────────────────────────────────────────────────

import MicrogridDashboardPage from "../page";

// ── Query builder helpers ─────────────────────────────────────────────────────
//
// buildQuery returns a fully chainable proxy so any call chain (select, eq,
// eq, order, limit, returns, etc.) resolves to { data, error: null }.
// This prevents breakage when new query chains are added to the page.

function buildQuery(data: unknown) {
  const terminal = () => Promise.resolve({ data, error: null });

  function makeChainable(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
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

  return makeChainable();
}

// Kept for backward-compat with existing test call sites.
function buildEdgesQuery(data: unknown) {
  return buildQuery(data);
}
function buildBillingPeriodsQuery(data: unknown) {
  return buildQuery(data);
}

function makeFrom(
  edgeRows: unknown,
  periodRows: unknown = [],
  microgridRow: unknown = { id: "mg-1", name: "Test Microgrid" },
) {
  return (table: string) => {
    if (table === "edges") return buildEdgesQuery(edgeRows);
    if (table === "billing_periods") return buildBillingPeriodsQuery(periodRows);
    if (table === "microgrids") return buildQuery(microgridRow);
    // All other tables (households, billing_line_items, microgrid_recent_activity)
    // return empty arrays so the page renders without widget data.
    return buildQuery([]);
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const OPENEMS_EDGE_ONLINE = {
  id: "edge-1",
  name: "Metering Pi",
  openems_edge_id: "edge0",
};

const OPENEMS_EDGE_OFFLINE = {
  id: "edge-2",
  name: "Backup Pi",
  openems_edge_id: "edge1",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MicrogridDashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders offline banner with offline edge name and link when one edge is offline", async () => {
    mockFrom.mockImplementation(
      makeFrom([OPENEMS_EDGE_ONLINE, OPENEMS_EDGE_OFFLINE]),
    );
    getEdgesStatusMock.mockResolvedValue([
      { edgeId: "edge0", online: true },
      { edgeId: "edge1", online: false },
    ]);

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Offline banner rendered
    expect(html).toContain("Edge offline");
    expect(html).toContain("Backup Pi");
    // Link to the offline edge's detail page
    expect(html).toContain("/microgrids/mg-1/setup/edges/edge-2/");
    // Online edge chip appears in the strip (but no banner for it)
    expect(html).not.toContain("Edge unreachable");
  });

  it("renders offline banner listing all offline edges when multiple edges are offline", async () => {
    const EDGE_3 = {
      id: "edge-4",
      name: "Third Pi",
      openems_edge_id: "edge2",
    };
    mockFrom.mockImplementation(
      makeFrom([OPENEMS_EDGE_ONLINE, OPENEMS_EDGE_OFFLINE, EDGE_3]),
    );
    getEdgesStatusMock.mockResolvedValue([
      { edgeId: "edge0", online: true },
      { edgeId: "edge1", online: false },
      { edgeId: "edge2", online: false },
    ]);

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // One banner for both offline edges
    expect(html).toContain("Edge offline");
    expect(html).toContain("Backup Pi");
    expect(html).toContain("Third Pi");
  });

  it("renders no banner when all OpenEMS edges are online", async () => {
    mockFrom.mockImplementation(makeFrom([OPENEMS_EDGE_ONLINE]));
    getEdgesStatusMock.mockResolvedValue([{ edgeId: "edge0", online: true }]);

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).not.toContain("Edge offline");
    expect(html).not.toContain("Edge unreachable");
    // Strip is rendered
    expect(html).toContain("Metering Pi");
  });

  it("renders 'Edge unreachable' banner when getEdgesStatus throws", async () => {
    mockFrom.mockImplementation(makeFrom([OPENEMS_EDGE_ONLINE]));
    getEdgesStatusMock.mockRejectedValue(new Error("network error"));

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Edge unreachable");
    expect(html).not.toContain("Edge offline");
  });

  it("renders info banner (not destructive) when zero edges are configured", async () => {
    mockFrom.mockImplementation(makeFrom([]));
    getEdgesStatusMock.mockResolvedValue([]);

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No edges configured");
    // Info tone classes (not destructive)
    expect(html).toContain("bg-muted");
    expect(html).not.toContain("bg-destructive-muted");
    // Link to setup edges
    expect(html).toContain("/microgrids/mg-1/setup/edges");
  });

  // (Removed: "non-OpenEMS edge shows unknown status" test — post-#101
  // OpenEMS is the only supported edge type, so that scenario no longer
  // exists in the schema.)

  it("preserves the draft billing period quick-action link", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "edges") return buildEdgesQuery([OPENEMS_EDGE_ONLINE]);
      if (table === "billing_periods") return buildBillingPeriodsQuery([
        { id: "bp-1", status: "draft", start_date: "2026-04-01" },
      ]);
      return buildEdgesQuery([]);
    });
    getEdgesStatusMock.mockResolvedValue([{ edgeId: "edge0", online: true }]);

    const jsx = await MicrogridDashboardPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("/microgrids/mg-1/billing/bp-1");
    expect(html).toContain("Open draft period");
  });
});
