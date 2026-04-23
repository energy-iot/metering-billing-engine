// Communities page server-component test (node environment).
//
// Strategy:
//   - Mock @/lib/supabase/server to control what the Supabase client returns.
//   - Call CommunitiesPage() directly (it is an async server component).
//   - Render the returned JSX with react-dom/server renderToStaticMarkup.
//   - Assert:
//     (a) Row renders with community name, city/country, and microgrid count.
//     (b) Empty state renders when the query returns zero rows.

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

const mockFrom = vi.fn();

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: mockFrom,
  }),
}));

// ─── Fixture data ─────────────────────────────────────────────────────────────

const COMMUNITY_WITH_DATA = {
  id: "comm-1",
  name: "Kisakye",
  address_city: "Kampala",
  address_country: "Uganda",
  microgrids: [{ count: 3 }],
};

const COMMUNITY_NO_LOCATION = {
  id: "comm-2",
  name: "Test Community",
  address_city: null,
  address_country: null,
  microgrids: [{ count: 1 }],
};

// ─── Import page (after mocks) ────────────────────────────────────────────────

import CommunitiesPage from "./page";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("CommunitiesPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a row with name, city/country, and microgrid count", async () => {
    mockFrom.mockReturnValue(makeMockBuilder([COMMUNITY_WITH_DATA]));

    const jsx = await CommunitiesPage();
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye");
    expect(html).toContain("Kampala, Uganda");
    expect(html).toContain("3 microgrids");
    // Link should point to /microgrids?community=<id>
    expect(html).toContain("/microgrids?community=comm-1");
  });

  it("renders multiple rows when multiple communities are returned", async () => {
    mockFrom.mockReturnValue(
      makeMockBuilder([COMMUNITY_WITH_DATA, COMMUNITY_NO_LOCATION])
    );

    const jsx = await CommunitiesPage();
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye");
    expect(html).toContain("Test Community");
    expect(html).toContain("1 microgrid");
  });

  it("renders empty state when query returns zero rows", async () => {
    mockFrom.mockReturnValue(makeMockBuilder([]));

    const jsx = await CommunitiesPage();
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No communities found");
    expect(html).not.toContain("Kisakye");
  });

  it("renders empty state when query returns null", async () => {
    mockFrom.mockReturnValue(makeMockBuilder(null));

    const jsx = await CommunitiesPage();
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No communities found");
  });
});
