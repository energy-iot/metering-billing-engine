// Setup > Edges listing — server component test (D2 / #53; updated post-#101).
//
// Strategy:
//   - Mock @/lib/supabase/server so the edges query returns fixture rows.
//   - Mock @/lib/openems so createOpenEmsClient yields deterministic
//     online/offline without touching a real backend.
//   - Mock @/lib/openems/config so we bypass the microgrid config fetch.
//   - Call SetupEdgesPage() directly and serialize returned JSX to HTML.

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

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
    createOpenEmsClient: () => ({ getEdgesStatus: getEdgesStatusMock }),
  };
});

vi.mock("@/lib/openems/config", () => ({
  getMicrogridEmsConfig: vi
    .fn()
    .mockResolvedValue({ type: "direct_url", url: "http://localhost:8075" }),
}));

// Stub getHierarchyLevels so page tests don't need a full Supabase mock chain.
vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

// Stub the client shell — uses useRouter which isn't available in server-component tests.
vi.mock("./edges-crud-shell", () => ({
  EdgesCRUDShell: () => null,
}));

// Stub EdgeEmptyState — client component (uses useState + AddEdgeDialog which
// uses useRouter — both unavailable in server-component renderToStaticMarkup tests).
vi.mock("./edge-empty-state", () => ({
  EdgeEmptyState: () => React.createElement("p", null, "No edges configured"),
}));

// Stub EdgeRowActions — client component that uses useRouter + Radix DropdownMenu.
vi.mock("./edge-row-actions", () => ({
  EdgeRowActions: () => null,
}));

// Stub currentUserCanAccessMicrogrid + currentUserIsSuperAdmin — always
// returns true for smoke tests.
vi.mock("@/lib/auth/access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/access")>(
    "@/lib/auth/access",
  );
  return {
    ...actual,
    currentUserCanAccessMicrogrid: vi.fn().mockResolvedValue(true),
    currentUserIsSuperAdmin: vi.fn().mockResolvedValue(true),
  };
});

import SetupEdgesPage from "./page";
import * as accessModule from "@/lib/auth/access";

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

// Microgrid row fetch (ems_type) — .select().eq().maybeSingle() chain.
function buildMicrogridRowQuery(emsType: string | null) {
  return {
    select: () => ({
      eq: () => ({
        maybeSingle: () =>
          Promise.resolve({ data: { ems_type: emsType }, error: null }),
      }),
    }),
  };
}

function mockFromDispatcher({
  edges,
  emsType = "direct_url",
}: {
  edges: unknown;
  emsType?: string | null;
}) {
  return (table: string) => {
    if (table === "microgrids") return buildMicrogridRowQuery(emsType);
    return buildEdgesQuery(edges);
  };
}

describe("SetupEdgesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders edges with source chip and live online status", async () => {
    mockFrom.mockImplementation(
      mockFromDispatcher({
        edges: [
          {
            id: "edge-1",
            name: "Metering Pi",
            openems_edge_id: "edge0",
            role: "metering",
          },
        ],
      }),
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
    mockFrom.mockImplementation(mockFromDispatcher({ edges: [] }));
    getEdgesStatusMock.mockResolvedValue([]);

    const jsx = await SetupEdgesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No edges configured");
  });

  it("falls back to Unknown status when OpenEMS is unreachable", async () => {
    mockFrom.mockImplementation(
      mockFromDispatcher({
        edges: [
          {
            id: "edge-1",
            name: "Metering Pi",
            openems_edge_id: "edge0",
            role: null,
          },
        ],
      }),
    );
    getEdgesStatusMock.mockRejectedValue(new Error("network down"));

    const jsx = await SetupEdgesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Live edge status unavailable");
    expect(html).toContain("Unknown");
  });

  // ── Gate banner / button gating (#103) ──────────────────────────────────

  it("shows the super_admin gate banner with a Go-to-Backend link when ems_type IS NULL", async () => {
    mockFrom.mockImplementation(
      mockFromDispatcher({ edges: [], emsType: null }),
    );
    getEdgesStatusMock.mockResolvedValue([]);

    const jsx = await SetupEdgesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("OpenEMS backend not configured");
    expect(html).toContain("Configure the OpenEMS backend");
    expect(html).toContain("Go to OpenEMS Backend");
    expect(html).toContain("/microgrids/mg-1/setup/openems-backend");
  });

  it("shows the org_manager gate banner (no link) when ems_type IS NULL and user is not super_admin", async () => {
    vi.mocked(accessModule.currentUserIsSuperAdmin).mockResolvedValueOnce(
      false,
    );
    mockFrom.mockImplementation(
      mockFromDispatcher({ edges: [], emsType: null }),
    );
    getEdgesStatusMock.mockResolvedValue([]);

    const jsx = await SetupEdgesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("OpenEMS backend not configured");
    expect(html).toContain("Ask a super admin");
    // org_manager banner should NOT carry the actionable link.
    expect(html).not.toContain("Go to OpenEMS Backend");
  });

  it("omits the gate banner when ems_type is configured", async () => {
    mockFrom.mockImplementation(
      mockFromDispatcher({ edges: [], emsType: "direct_url" }),
    );
    getEdgesStatusMock.mockResolvedValue([]);

    const jsx = await SetupEdgesPage({
      params: Promise.resolve({ id: "mg-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).not.toContain("OpenEMS backend not configured");
    expect(html).not.toContain("Ask a super admin");
  });
});
