// Setup > Edges listing — server component test (D2 / #53).
//
// Strategy:
//   - Mock @/lib/supabase/server so the edges query returns fixture rows.
//   - Mock @/lib/openems so getEdgesStatus yields deterministic online/offline
//     without touching a real backend.
//   - Call SetupEdgesPage() directly (async server component) and serialize
//     the returned JSX to HTML.
//   - Assert edge name, OpenEMS id, and status chip rendering.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

const getEdgesStatusMock = vi.fn();
vi.mock("@/lib/openems", async () => {
  const actual = await vi.importActual<typeof import("@/lib/openems")>(
    "@/lib/openems",
  );
  return {
    ...actual,
    getOpenEmsClient: () => ({ getEdgesStatus: getEdgesStatusMock }),
  };
});

// Stub getHierarchyLevels so page tests don't need a full Supabase mock chain.
vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

import SetupEdgesPage from "./page";

function buildEdgesQuery(data: unknown) {
  return {
    select: () => ({
      eq: () => ({
        order: () => ({
          returns: () => Promise.resolve({ data, error: null }),
        }),
      }),
    }),
  };
}

describe("SetupEdgesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders edges with source chip and live online status", async () => {
    mockFrom.mockImplementation(() =>
      buildEdgesQuery([
        {
          id: "edge-1",
          name: "Metering Pi",
          data_source_type: "openems",
          openems_edge_id: "edge0",
          openems_backend_url: "http://openems",
          role: "metering",
        },
      ]),
    );
    getEdgesStatusMock.mockResolvedValue([{ edgeId: "edge0", online: true }]);

    const jsx = await SetupEdgesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Metering Pi");
    expect(html).toContain("edge0");
    // Source chip + online edge chip both show up
    expect(html).toContain("OpenEMS");
    expect(html).toContain("Online");
  });

  it("renders the empty state when no edges exist", async () => {
    mockFrom.mockImplementation(() => buildEdgesQuery([]));
    getEdgesStatusMock.mockResolvedValue([]);

    const jsx = await SetupEdgesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No edges configured");
  });

  it("falls back to Unknown status when OpenEMS is unreachable", async () => {
    mockFrom.mockImplementation(() =>
      buildEdgesQuery([
        {
          id: "edge-1",
          name: "Metering Pi",
          data_source_type: "openems",
          openems_edge_id: "edge0",
          openems_backend_url: "http://openems",
          role: null,
        },
      ]),
    );
    getEdgesStatusMock.mockRejectedValue(new Error("network down"));

    const jsx = await SetupEdgesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Live edge status unavailable");
    expect(html).toContain("Unknown");
  });
});
