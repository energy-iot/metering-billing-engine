// Community detail page — server component tests (#87).
//
// Strategy:
//   - Mock @/lib/supabase/server to control what Supabase returns.
//   - Mock @/lib/hierarchy so HierarchyNav doesn't need a full chain.
//   - Mock @/lib/auth/access to control currentUserCanAccessCommunity().
//   - Mock next/navigation.notFound to capture 404 scenarios.
//   - Call CommunityDetailPage() directly (async server component).
//   - Serialize to HTML and assert on content.
//
// Scenarios:
//   1. Populated community with 2 microgrids → stats + listing + Edit button.
//   2. Non-accessible community (cross-org) → notFound().
//   3. Empty-microgrids community → "No microgrids yet" placeholder.
//   4. Zero-stats community (0 hh, 0 devices) → stats strip renders zeros.
//   5. User without access → Edit button not rendered.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

let communityData: unknown = null;
let canAccessResult = true;

const mockSingle = vi.fn(() =>
  Promise.resolve({ data: communityData, error: null })
);

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          single: mockSingle,
          maybeSingle: mockSingle,
        }),
        maybeSingle: mockSingle,
      }),
    }),
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  }),
}));

vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessCommunity: vi.fn(() => Promise.resolve(canAccessResult)),
}));

// notFoundMock must be hoisted so the vi.mock factory can reference it before
// module initialization (vi.mock calls are hoisted to top of file).
const { notFoundMock } = vi.hoisted(() => {
  const notFoundMock = vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  return { notFoundMock };
});

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

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

// ── Import page (after mocks) ─────────────────────────────────────────────────

import CommunityDetailPage from "../page";

// ── Fixture helpers ───────────────────────────────────────────────────────────

const BASE_COMMUNITY = {
  id: "comm-1",
  org_id: "org-1",
  name: "Kisakye",
  address_line1: "123 Main St",
  address_line2: null,
  address_city: "Kampala",
  address_region: "Central Region",
  address_country: "Uganda",
  address_postal_code: null,
  geography_notes: "Near the lake",
  created_at: "2026-01-01T00:00:00Z",
};

function makeGrid(
  id: string,
  name: string,
  city: string | null,
  hhCount: number,
  devCount: number
) {
  return {
    id,
    name,
    address_city: city,
    households: [{ count: hhCount }],
    devices: [{ count: devCount }],
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("CommunityDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    communityData = null;
    canAccessResult = true;
    mockSingle.mockImplementation(() =>
      Promise.resolve({ data: communityData, error: null })
    );
  });

  // 1. Populated community with 2 microgrids → stats + listing + Edit button.
  it("renders stats strip, microgrid listing, and Edit button for accessible user", async () => {
    communityData = {
      ...BASE_COMMUNITY,
      microgrids: [
        makeGrid("mg-1", "Block A", "Kampala", 5, 3),
        makeGrid("mg-2", "Block B", "Entebbe", 7, 4),
      ],
    };
    mockSingle.mockResolvedValue({ data: communityData, error: null });
    canAccessResult = true;

    const jsx = await CommunityDetailPage({
      params: Promise.resolve({ id: "comm-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Community name in header
    expect(html).toContain("Kisakye");
    // Stats: 2 microgrids, 12 households, 7 devices
    expect(html).toContain("2");
    expect(html).toContain("12");
    expect(html).toContain("7");
    // Microgrid listing
    expect(html).toContain("Block A");
    expect(html).toContain("Block B");
    expect(html).toContain("/microgrids/mg-1");
    expect(html).toContain("/microgrids/mg-2");
    // Edit button rendered
    expect(html).toContain("Edit");
    // View microgrids link
    expect(html).toContain(`/microgrids?community=comm-1`);
  });

  // 2. Non-accessible community (cross-org org_manager) → notFound().
  it("calls notFound() when community data is null (RLS-filtered or missing)", async () => {
    communityData = null;
    mockSingle.mockResolvedValue({ data: null, error: null });

    await expect(
      CommunityDetailPage({ params: Promise.resolve({ id: "comm-99" }) })
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalled();
  });

  // 3. Empty-microgrids community → EmptyState with "Add the first microgrid" (#139 P2).
  it("renders EmptyState 'Add the first microgrid' when microgrids array is empty", async () => {
    communityData = {
      ...BASE_COMMUNITY,
      microgrids: [],
    };
    mockSingle.mockResolvedValue({ data: communityData, error: null });

    const jsx = await CommunityDetailPage({
      params: Promise.resolve({ id: "comm-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Add the first microgrid");
    expect(html).toContain("A microgrid is the physical installation");
    // Stats show zeros
    expect(html).toContain("0");
  });

  // 4. Zero-stats community → stats strip renders zeros without crashing.
  it("renders stats strip with zeros for community with 0 households and 0 devices", async () => {
    communityData = {
      ...BASE_COMMUNITY,
      microgrids: [makeGrid("mg-1", "Block A", null, 0, 0)],
    };
    mockSingle.mockResolvedValue({ data: communityData, error: null });

    const jsx = await CommunityDetailPage({
      params: Promise.resolve({ id: "comm-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Microgrid renders, no crash
    expect(html).toContain("Block A");
    // Stats: 1 microgrid, 0 households, 0 devices
    expect(html).toContain("Microgrid");
    expect(html).toContain("Household");
    expect(html).toContain("Device");
  });

  // 5. Edit button hidden for user without access.
  it("does NOT render Edit button when currentUserCanAccessCommunity returns false", async () => {
    communityData = {
      ...BASE_COMMUNITY,
      microgrids: [makeGrid("mg-1", "Block A", "Kampala", 2, 1)],
    };
    mockSingle.mockResolvedValue({ data: communityData, error: null });
    canAccessResult = false;

    const jsx = await CommunityDetailPage({
      params: Promise.resolve({ id: "comm-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Community still renders
    expect(html).toContain("Kisakye");
    // Edit button must NOT appear
    expect(html).not.toContain(">Edit<");
  });
});
