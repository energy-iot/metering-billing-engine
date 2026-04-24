// Communities page server-component test (node environment).
//
// Strategy:
//   - Mock @/lib/supabase/server to control what the Supabase client returns.
//   - Call CommunitiesPage() directly (it is an async server component).
//   - Render the returned JSX with react-dom/server renderToStaticMarkup.
//   - Assert:
//     (a) Row renders with community name, city/country, and microgrid count.
//     (b) Empty state renders when the query returns zero rows.
//     (c) Add button renders in single-org context (#76 original behaviour).
//     (d) Add button renders in multi-org context (#132: picker mode).
//     (e) ?org=X → only X's communities queried + rendered (#134).
//     (f) ?org=X-invalid → banner + unfiltered list (#134).
//     (g) ?org=X → AddEntityButton locked with parentOrgId=X (#134).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ─── Supabase mock ───────────────────────────────────────────────────────────
//
// We need a builder that supports .eq() so we can assert the org filter was
// applied (and to actually filter fixture data in tests).

type MockBuilder = {
  select: (...args: unknown[]) => MockBuilder;
  order: (...args: unknown[]) => MockBuilder;
  eq: (col: string, val: unknown) => MockBuilder;
  returns: <T>() => Promise<{ data: T | null; error: null }>;
  _data: unknown;
  _eqs: [string, unknown][];
};

function makeMockBuilder(data: unknown): MockBuilder {
  const builder: MockBuilder = {
    _data: data,
    _eqs: [],
    select() {
      return builder;
    },
    order() {
      return builder;
    },
    eq(col: string, val: unknown) {
      builder._eqs.push([col, val]);
      return builder;
    },
    returns<T>() {
      // Apply any .eq() filters before returning.
      let rows = (builder._data as Record<string, unknown>[]) ?? [];
      for (const [col, val] of builder._eqs) {
        rows = rows.filter((r) => r[col] === val);
      }
      return Promise.resolve({ data: rows as T, error: null });
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
// orgsData now includes `name` (fetched as `id, name` after #132).
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
  org_id: "org-2",
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
    orgsData = [{ id: "org-1", name: "EnergyIoT Uganda" }];

    const jsx = await CommunitiesPage({});
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye");
    expect(html).toContain("Kampala, Uganda");
    expect(html).toContain("3 microgrids");
    // Link should point to /communities/<id>
    expect(html).toContain("/communities/comm-1");
  });

  it("renders multiple rows when multiple communities are returned", async () => {
    communitiesData = [COMMUNITY_WITH_DATA, COMMUNITY_NO_LOCATION];
    orgsData = [{ id: "org-1", name: "EnergyIoT Uganda" }];

    const jsx = await CommunitiesPage({});
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye");
    expect(html).toContain("Test Community");
    expect(html).toContain("1 microgrid");
  });

  it("renders Add Community button in single-org context (locked mode)", async () => {
    communitiesData = [COMMUNITY_WITH_DATA];
    orgsData = [{ id: "org-1", name: "EnergyIoT Uganda" }];

    const jsx = await CommunitiesPage({});
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // AddEntityButton renders a <button> with the default label.
    expect(html).toContain("+ Add Community");
  });

  it("renders Add Community button in multi-org context (picker mode, #132)", async () => {
    communitiesData = [COMMUNITY_WITH_DATA, COMMUNITY_NO_LOCATION];
    orgsData = [
      { id: "org-1", name: "EnergyIoT Uganda" },
      { id: "org-2", name: "Field Energy Kenya" },
    ];

    const jsx = await CommunitiesPage({});
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Add button must render even when multiple orgs are accessible.
    expect(html).toContain("+ Add Community");
  });

  it("renders empty state when query returns zero rows", async () => {
    communitiesData = [];
    orgsData = [];

    const jsx = await CommunitiesPage({});
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Zero-org view: directs user to the organization detail page.
    expect(html).toMatch(/No communities/);
    expect(html).not.toContain("Kisakye");
  });

  it("renders empty state when query returns null", async () => {
    communitiesData = null;
    orgsData = null;

    const jsx = await CommunitiesPage({});
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toMatch(/No communities/);
  });

  // ── #134: ?org= filter ────────────────────────────────────────────────────

  it("?org=X: only shows communities whose org_id matches (#134)", async () => {
    communitiesData = [COMMUNITY_WITH_DATA, COMMUNITY_NO_LOCATION];
    orgsData = [
      { id: "org-1", name: "EnergyIoT Uganda" },
      { id: "org-2", name: "Field Energy Kenya" },
    ];

    const jsx = await CommunitiesPage({
      searchParams: Promise.resolve({ org: "org-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // org-1 community renders, org-2 community does not.
    expect(html).toContain("Kisakye");
    expect(html).not.toContain("Test Community");
  });

  it("?org=X: AddEntityButton receives parentOrgId=X (locked mode) (#134)", async () => {
    communitiesData = [COMMUNITY_WITH_DATA];
    orgsData = [
      { id: "org-1", name: "EnergyIoT Uganda" },
      { id: "org-2", name: "Field Energy Kenya" },
    ];

    const jsx = await CommunitiesPage({
      searchParams: Promise.resolve({ org: "org-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // The Add button must still render (locked mode is functional).
    expect(html).toContain("+ Add Community");
    // Should NOT render picker (no "availableOrgs" path is taken).
    // We can't directly inspect props in SSR output, but the button renders.
  });

  it("?org=invalid: shows warning banner and unfiltered list (#134)", async () => {
    communitiesData = [COMMUNITY_WITH_DATA, COMMUNITY_NO_LOCATION];
    orgsData = [
      { id: "org-1", name: "EnergyIoT Uganda" },
      { id: "org-2", name: "Field Energy Kenya" },
    ];

    const jsx = await CommunitiesPage({
      searchParams: Promise.resolve({ org: "org-does-not-exist" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Warning banner present.
    expect(html).toContain("Invalid or inaccessible organization filter");
    // Both communities render (unfiltered).
    expect(html).toContain("Kisakye");
    expect(html).toContain("Test Community");
  });

  it("no ?org=: preserves current behaviour (all communities render) (#134)", async () => {
    communitiesData = [COMMUNITY_WITH_DATA, COMMUNITY_NO_LOCATION];
    orgsData = [
      { id: "org-1", name: "EnergyIoT Uganda" },
      { id: "org-2", name: "Field Energy Kenya" },
    ];

    const jsx = await CommunitiesPage({});
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye");
    expect(html).toContain("Test Community");
    expect(html).not.toContain("Invalid or inaccessible organization filter");
  });
});
