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

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

// ─── Supabase mock ─────────────────────────────────────────────────────────────
//
// Mirrors the pattern in src/lib/__tests__/hierarchy.test.ts:
// each table has its data rows; .eq() filters, .single()/.maybeSingle() return
// the first matching row, .returns() returns all matching rows.
// households always returns count=0 (head:true shape).

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
        rows = rows.filter((r) => r[col] === val);
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
    then(resolve: (v: { count: number }) => unknown) {
      // head:true count query awaited directly.
      if (_head) {
        return Promise.resolve({ count: 0 }).then(resolve);
      }
      // Should not normally be reached.
      return Promise.resolve({ data: null, error: null }).then(resolve);
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
};

const ORG_ROW = { id: "o-1", name: "EnergyIoT Uganda" };

const COMMUNITY_ROWS = [
  { id: "c-1", name: "Kisakye", org_id: "o-1", organizations: { name: "EnergyIoT Uganda" } },
  { id: "c-2", name: "Gulu", org_id: "o-1", organizations: { name: "EnergyIoT Uganda" } },
];

// ─── Import page (after mocks) ────────────────────────────────────────────────

import MicrogridsPage from "./page";

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("MicrogridsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tables = {
      organizations: [ORG_ROW],
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
});
