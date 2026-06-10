// Dashboard root page — server component tests.
//
// Strategy (mirrors microgrids/[id]/__tests__/page.test.tsx):
//   - Mock @/lib/supabase/server to return fixture microgrids and household
//     counts via a fully chainable query proxy.
//   - Call OrgCard() directly (async server component that renders the
//     org-panel microgrid cards) and serialize the returned JSX to HTML with
//     renderToStaticMarkup. The root DashboardPage delegates per-org data
//     fetching to OrgCard, so testing OrgCard exercises the card markup
//     without the nested-async-component suspend that renderToStaticMarkup
//     cannot await.
//   - Assert the cards render as <a> anchors with href="/microgrids/<id>"
//     (Support-reported P2: cards must be clickable).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type React from "react";

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

// ── Import component under test (after mocks) ─────────────────────────────────

import { OrgCard } from "../page";

// ── Query builder helpers ─────────────────────────────────────────────────────
//
// buildQuery returns a fully chainable proxy so any call chain (select, eq,
// returns, count/head, etc.) resolves to { data, error: null, count }.

function buildQuery(data: unknown, count: number | null = null) {
  const result = { data, error: null, count };
  const terminal = () => Promise.resolve(result);

  function makeChainable(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "returns") return terminal;
        if (prop === "then") {
          return (resolve: (v: typeof result) => unknown) =>
            Promise.resolve(result).then(resolve);
        }
        return () => makeChainable();
      },
    });
  }

  return makeChainable();
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ORG = { id: "org-1", name: "Acme Energy" };
const MICROGRID = {
  id: "mg-1",
  name: "North Grid",
  address_city: "Kampala",
  address_country: "Uganda",
  currency: "UGX",
  community_id: "comm-1",
};

function wireFrom() {
  mockFrom.mockImplementation((table: string) => {
    if (table === "microgrids") return buildQuery([MICROGRID]);
    if (table === "households") return buildQuery(null, 3);
    return buildQuery([]);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("DashboardPage org-panel microgrid cards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wireFrom();
  });

  it("renders each microgrid card as an anchor linking to its detail page", async () => {
    const tree = await OrgCard({ org: ORG as never });
    const html = renderToStaticMarkup(tree as React.ReactElement);

    expect(html).toContain('href="/microgrids/mg-1"');
    expect(html).toContain("North Grid");
  });

  it("renders the household count and currency inside the card", async () => {
    const tree = await OrgCard({ org: ORG as never });
    const html = renderToStaticMarkup(tree as React.ReactElement);

    expect(html).toContain("3 households");
    expect(html).toContain("UGX");
  });
});
