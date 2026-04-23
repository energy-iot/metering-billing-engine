// Setup > Edges listing — server component test (D2 / #53; updated post-#101).
//
// Strategy:
//   - Mock @/lib/supabase/server so the edges query returns fixture rows.
//   - Mock @/lib/openems so createOpenEmsClient yields deterministic
//     online/offline without touching a real backend.
//   - Mock @/lib/openems/config so we bypass the microgrid config fetch.
//   - Call SetupEdgesPage() directly and serialize returned JSX to HTML.

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

// Stub EdgeRowActions — client component that uses useRouter + Radix DropdownMenu.
vi.mock("./edge-row-actions", () => ({
  EdgeRowActions: () => null,
}));

// Stub currentUserCanAccessMicrogrid — always returns true for smoke tests.
vi.mock("@/lib/auth/access", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth/access")>(
    "@/lib/auth/access",
  );
  return { ...actual, currentUserCanAccessMicrogrid: vi.fn().mockResolvedValue(true) };
});

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
          openems_edge_id: "edge0",
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
          openems_edge_id: "edge0",
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
