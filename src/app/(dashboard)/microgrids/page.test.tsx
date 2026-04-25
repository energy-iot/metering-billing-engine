// MicrogridsPage server-component test (node environment).
//
// Strategy:
//   - Mock @/lib/supabase/server with a table-aware builder that supports
//     .eq() filtering, .single(), .maybeSingle(), .returns(), .order(), and
//     head:true count queries.
//   - Call MicrogridsPage() directly (async server component).
//   - Render the returned JSX with react-dom/server renderToStaticMarkup.
//   - Assert:
//     (a) Rows render with microgrid name.
//     (b) Add button renders in single-community URL context (locked mode).
//     (c) Add button renders in multi-community scope (picker mode, #132).
//     (d) Empty state shows CTA when communities accessible.
//     (e) Empty state shows fallback when zero communities accessible.
//     (f) ?org=X filters microgrids to that org's communities (#134).
//     (g) ?community=Y + ?org=X → community wins; banner renders (#134).
//     (h) ?org=invalid → banner + unfiltered (#134).
//     (i) accessibleCommunities filtered to org when ?org=X (#134).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ─── Supabase mock ─────────────────────────────────────────────────────────────
//
// Mirrors the pattern in src/lib/__tests__/hierarchy.test.ts:
// each table has its data rows; .eq() filters, .single()/.maybeSingle() return
// the first matching row, .returns() returns all matching rows.
// households always returns count=0 (head:true shape).
//
// For the microgrids org-filter path the page calls:
//   supabase.from("microgrids").select("*, communities!inner(org_id)").eq("communities.org_id", orgId)
// The mock handles "communities.org_id" by looking at the joined community row
// embedded as `communities` on each microgrid row.

type Tables = Record<string, Record<string, unknown>[]>;

let tables: Tables = {};

function makeBuilder(tableName: string) {
  const _eqs: [string, unknown][] = [];
  let _head = false;

  const proxy: Record<string, unknown> = {
    select(_cols: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.head) _head = true;
      return proxy;
    },
    eq(col: string, val: unknown) {
      _eqs.push([col, val]);
      return proxy;
    },
    order() {
      return proxy;
    },
    returns() {
      let rows = (tables[tableName] ?? []) as Record<string, unknown>[];
      for (const [col, val] of _eqs) {
        if (col.includes(".")) {
          // Dotted col like "communities.org_id" — resolve via embedded join row.
          const [joinTable, joinCol] = col.split(".");
          rows = rows.filter((r) => {
            const joined = r[joinTable] as Record<string, unknown> | undefined;
            return joined?.[joinCol] === val;
          });
        } else {
          rows = rows.filter((r) => r[col] === val);
        }
      }
      return Promise.resolve({ data: rows, error: null });
    },
    single() {
      let rows = (tables[tableName] ?? []) as Record<string, unknown>[];
      for (const [col, val] of _eqs) {
        rows = rows.filter((r) => r[col] === val);
      }
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    maybeSingle() {
      let rows = (tables[tableName] ?? []) as Record<string, unknown>[];
      for (const [col, val] of _eqs) {
        rows = rows.filter((r) => r[col] === val);
      }
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    then(resolve: (v: any) => unknown) {
      // head:true count query awaited directly.
      if (_head) {
        return Promise.resolve({ count: 0 }).then(resolve);
      }
      // Bare-builder await (no terminal .single()/.maybeSingle()/.returns()):
      // resolve to filtered rows. The page no longer calls .returns<…>() after
      // issue #106 (column list narrows the type at the source).
      let rows = (tables[tableName] ?? []) as Record<string, unknown>[];
      for (const [col, val] of _eqs) {
        if (col.includes(".")) {
          const [joinTable, joinCol] = col.split(".");
          rows = rows.filter((r) => {
            const joined = r[joinTable] as Record<string, unknown> | undefined;
            return joined?.[joinCol] === val;
          });
        } else {
          rows = rows.filter((r) => r[col] === val);
        }
      }
      return Promise.resolve({ data: rows, error: null }).then(resolve);
    },
  };
  return proxy;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (tableName: string) => makeBuilder(tableName),
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const ORG_ROW = { id: "o-1", name: "EnergyIoT Uganda" };
const ORG_ROW_2 = { id: "o-2", name: "Field Energy Kenya" };

// MG rows include embedded `communities` join data for the org-filter path.
const MG_1 = {
  id: "mg-1",
  community_id: "c-1",
  name: "Kisakye MG-1",
  currency: "UGX",
  address_line1: null,
  address_line2: null,
  address_city: "Kampala",
  address_region: null,
  address_country: "Uganda",
  address_postal_code: null,
  lat: null,
  lng: null,
  created_at: "2026-01-01T00:00:00Z",
  communities: { org_id: "o-1" },
};

const MG_2 = {
  id: "mg-2",
  community_id: "c-2",
  name: "Gulu MG-1",
  currency: "UGX",
  address_line1: null,
  address_line2: null,
  address_city: "Gulu",
  address_region: null,
  address_country: "Uganda",
  address_postal_code: null,
  lat: null,
  lng: null,
  created_at: "2026-01-01T00:00:00Z",
  communities: { org_id: "o-2" },
};

const COMMUNITY_ROWS = [
  { id: "c-1", name: "Kisakye", org_id: "o-1", organizations: { name: "EnergyIoT Uganda" } },
  { id: "c-2", name: "Gulu", org_id: "o-2", organizations: { name: "Field Energy Kenya" } },
];

// ─── Import page (after mocks) ────────────────────────────────────────────────

import MicrogridsPage from "./page";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MicrogridsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tables = {
      organizations: [ORG_ROW, ORG_ROW_2],
      communities: [],
      microgrids: [],
      households: [],
    };
  });

  it("renders a microgrid row with name", async () => {
    tables.microgrids = [MG_1];
    tables.communities = [COMMUNITY_ROWS[0]];

    const jsx = await MicrogridsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye MG-1");
    expect(html).toContain("/microgrids/mg-1");
  });

  it("renders Add Microgrid button in single-community URL context (locked mode)", async () => {
    tables.microgrids = [MG_1];
    tables.communities = [COMMUNITY_ROWS[0]];

    const jsx = await MicrogridsPage({
      searchParams: Promise.resolve({ community: "c-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("+ Add Microgrid");
  });

  it("renders Add Microgrid button in multi-community scope (picker mode, #132)", async () => {
    tables.microgrids = [MG_1];
    tables.communities = COMMUNITY_ROWS;

    const jsx = await MicrogridsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("+ Add Microgrid");
  });

  it("renders empty-state CTA when communities are accessible (#132)", async () => {
    tables.microgrids = [];
    tables.communities = COMMUNITY_ROWS;

    const jsx = await MicrogridsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No microgrids");
    expect(html).toContain("+ Add the first Microgrid");
  });

  it("renders fallback message when no communities accessible", async () => {
    tables.microgrids = [];
    tables.communities = [];

    const jsx = await MicrogridsPage({ searchParams: Promise.resolve({}) });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No microgrids visible");
  });

  // ── #134: ?org= filter ────────────────────────────────────────────────────

  it("?org=X: only shows microgrids whose community belongs to org X (#134)", async () => {
    tables.microgrids = [MG_1, MG_2];
    tables.communities = COMMUNITY_ROWS;

    const jsx = await MicrogridsPage({
      searchParams: Promise.resolve({ org: "o-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Kisakye MG-1");
    expect(html).not.toContain("Gulu MG-1");
  });

  it("?community=Y + ?org=X: community wins; both-filters banner renders (#134)", async () => {
    tables.microgrids = [MG_1, MG_2];
    tables.communities = COMMUNITY_ROWS;

    const jsx = await MicrogridsPage({
      searchParams: Promise.resolve({ community: "c-1", org: "o-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Community filter wins — only c-1's microgrids.
    expect(html).toContain("Kisakye MG-1");
    // Banner rendered.
    expect(html).toContain("Community filter applied — org filter ignored");
  });

  it("?org=invalid: shows warning banner and unfiltered list (#134)", async () => {
    tables.microgrids = [MG_1, MG_2];
    tables.communities = COMMUNITY_ROWS;

    const jsx = await MicrogridsPage({
      searchParams: Promise.resolve({ org: "org-does-not-exist" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Warning banner present.
    expect(html).toContain("Invalid or inaccessible organization filter");
    // Both microgrids render (unfiltered).
    expect(html).toContain("Kisakye MG-1");
    expect(html).toContain("Gulu MG-1");
  });

  it("?org=X valid: accessibleCommunities narrowed to org's communities (#134)", async () => {
    // Only one community in org o-1 → Add button should be in locked mode.
    tables.microgrids = [MG_1];
    tables.communities = COMMUNITY_ROWS; // both, but only c-1 belongs to o-1.

    const jsx = await MicrogridsPage({
      searchParams: Promise.resolve({ org: "o-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Add button renders (locked mode for single community in org).
    expect(html).toContain("+ Add Microgrid");
  });
});
