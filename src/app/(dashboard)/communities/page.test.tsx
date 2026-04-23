// Communities page server-component test (node environment).
//
// Strategy:
//   - Mock @/lib/supabase/server to control what the Supabase client returns.
//   - Call CommunitiesPage() directly (it is an async server component).
//   - Render the returned JSX with react-dom/server renderToStaticMarkup.
//   - Assert:
//     (a) Row renders with community name, city/country, and microgrid count.
//     (b) Empty state renders when the query returns zero rows.
//
// Note: after #76 (UX4a), the listing query selects `*, microgrids(count)` so
// row rendering receives the full Community row shape. Empty-state copy
// diverges per access: org_manager (1 accessible org) sees an add CTA;
// anonymous / 0-org view sees "add from the organization detail page".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ─── Supabase mock ───────────────────────────────────────────────────────────

type MockBuilder = {
  select: (...args: unknown[]) => MockBuilder;
  order: (...args: unknown[]) => MockBuilder;
  returns: <T>() => Promise<{ data: T | null; error: null }>;
  _data: unknown;
};

function makeMockBuilder(data: unknown): MockBuilder {
  const builder: MockBuilder = {
    _data: data,
    select() {
      return builder;
    },
    order() {
      return builder;
    },
    returns<T>() {
      return Promise.resolve({ data: builder._data as T, error: null });
    },
  };
  return builder;
}

// Map table name → data. Supabase `.from('communities')` or `.from('organizations')`
// each get their own mock-builder.
const mockFrom = vi.fn((table: string) => {
  if (table === "organizations") {
    return makeMockBuilder(orgsData);
  }
  return makeMockBuilder(communitiesData);
});

// Mutable test-scoped state so each test can control what the DB returns.
let communitiesData: unknown = [];
let orgsData: unknown = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  }),
}));

// The listing page renders <EditEntityButton> (client component) per row, which
// in turn mounts <EntityForm> using `useRouter()`. Static SSR has no router
// context, so mock `next/navigation` → a no-op router.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

// ─── Fixture data ─────────────────────────────────────────────────────────────

const COMMUNITY_WITH_DATA = {
  id: "comm-1",
  org_id: "org-1",
  name: "Kisakye",
  address_line1: null,
  address_line2: null,
  address_city: "Kampala",
  address_region: null,
  address_country: "Uganda",
  address_postal_code: null,
  geography_notes: null,
  created_at: "2026-01-01T00:00:00Z",
  microgrids: [{ count: 3 }],
};

const COMMUNITY_NO_LOCATION = {
  id: "comm-2",
  org_id: "org-1",
  name: "Test Community",
  address_line1: null,
  address_line2: null,
  address_city: null,
  address_region: null,
  address_country: null,
  address_postal_code: null,
  geography_notes: null,
  created_at: "2026-01-01T00:00:00Z",
  microgrids: [{ count: 1 }],
};

// ─── Import page (after mocks) ────────────────────────────────────────────────

import CommunitiesPage from "./page";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CommunitiesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    communitiesData = [];
    orgsData = [];
  });

  it("renders a row with name, city/country, and microgrid count", async () => {
    communitiesData = [COMMUNITY_WITH_DATA];
    orgsData = [{ id: "org-1" }];

    const jsx = await CommunitiesPage();
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye");
    expect(html).toContain("Kampala, Uganda");
    expect(html).toContain("3 microgrids");
    // Link should point to /microgrids?community=<id>
    expect(html).toContain("/microgrids?community=comm-1");
  });

  it("renders multiple rows when multiple communities are returned", async () => {
    communitiesData = [COMMUNITY_WITH_DATA, COMMUNITY_NO_LOCATION];
    orgsData = [{ id: "org-1" }];

    const jsx = await CommunitiesPage();
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye");
    expect(html).toContain("Test Community");
    expect(html).toContain("1 microgrid");
  });

  it("renders empty state when query returns zero rows", async () => {
    communitiesData = [];
    orgsData = [];

    const jsx = await CommunitiesPage();
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // After #76, empty state splits by access. For zero-org view it directs
    // the user to the organization detail page.
    expect(html).toMatch(/No communities/);
    expect(html).not.toContain("Kisakye");
  });

  it("renders empty state when query returns null", async () => {
    communitiesData = null;
    orgsData = null;

    const jsx = await CommunitiesPage();
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toMatch(/No communities/);
  });
});
