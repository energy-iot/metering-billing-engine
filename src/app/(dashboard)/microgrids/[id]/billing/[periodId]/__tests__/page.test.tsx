/**
 * billing/[periodId]/page.test.tsx — regression test for the page-level
 * supabase query.
 *
 * Why this exists: an earlier revision asked PostgREST for a non-existent
 * `user_directory.display_name` column, producing a 500 on every billing
 * detail page in production. The previous unit test for this surface
 * (`billing-table.test.tsx`) mocks the `actorByLineItemId` prop directly
 * — so it never exercises the page loader. TypeScript also can't catch
 * the bug because `LineItemWithActor` is a hand-written `.returns<>()`
 * shape that fabricates whatever fields it claims.
 *
 * Strategy:
 *   - Mock @/lib/supabase/server with a per-table dispatcher. The
 *     `billing_line_items` builder returns rows shaped like the REAL
 *     `user_directory` view (`first_name`, `last_name`, `email` — NO
 *     `display_name`).
 *   - Mock @/components/BillingTable as a stub that serializes the
 *     `actorByLineItemId` prop into the rendered HTML, so we can
 *     assert what the page computed for each line item.
 *   - Render the page server-side and snapshot the captured map.
 *
 * Coverage (mirrors `pickDisplayName` in src/lib/billing/audit-log-fetch.ts):
 *   1. first_name + last_name → "Alejandro Malbet"
 *   2. first_name only → "Alejandro"
 *   3. email-only fallback (both names null) → "alejandro@example.com"
 *   4. null user_directory join (entered_by_user_id IS NULL or RLS-hidden)
 *      → null actor
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";

const MICROGRID_ID = "770e8400-e29b-41d4-a716-446655442000";
const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";
const LI_FULL = "990e8400-e29b-41d4-a716-446655444001";
const LI_FIRST_ONLY = "990e8400-e29b-41d4-a716-446655444002";
const LI_EMAIL_ONLY = "990e8400-e29b-41d4-a716-446655444003";
const LI_NO_JOIN = "990e8400-e29b-41d4-a716-446655444004";

// Holders we mutate per-test.
let MOCK_LINE_ITEMS: Array<Record<string, unknown>> = [];
let LAST_LINE_ITEMS_SELECT = "";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Generic chainable proxy for query chains we don't need to inspect.
function buildQuery(data: unknown) {
  function makeChainable(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "returns") return () => Promise.resolve({ data, error: null });
        if (prop === "single" || prop === "maybeSingle")
          return () => Promise.resolve({ data, error: null });
        if (prop === "then") {
          return (resolve: (v: { data: unknown; error: null }) => unknown) =>
            Promise.resolve({ data, error: null }).then(resolve);
        }
        return () => makeChainable();
      },
    });
  }
  return makeChainable();
}

// Specialized chain for billing_line_items so we can capture the
// SELECT string the page sends to PostgREST. This lets us assert that
// the page does NOT request the nonexistent `display_name` column.
function buildLineItemsQuery() {
  const terminal = () =>
    Promise.resolve({ data: MOCK_LINE_ITEMS, error: null });
  function makeChainable(): Record<string, unknown> {
    return new Proxy({} as Record<string, unknown>, {
      get(_target, prop) {
        if (prop === "select") {
          return (sel: string) => {
            LAST_LINE_ITEMS_SELECT = sel;
            return makeChainable();
          };
        }
        if (prop === "returns") return terminal;
        if (prop === "then") {
          return (resolve: (v: { data: unknown; error: null }) => unknown) =>
            Promise.resolve({ data: MOCK_LINE_ITEMS, error: null }).then(resolve);
        }
        return () => makeChainable();
      },
    });
  }
  return makeChainable();
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table === "billing_line_items") return buildLineItemsQuery();
      if (table === "billing_periods")
        return buildQuery({ id: PERIOD_ID, microgrid_id: MICROGRID_ID });
      if (table === "households") return buildQuery([]);
      if (table === "rate_schedules") return buildQuery(null);
      if (table === "microgrids")
        return buildQuery({
          id: MICROGRID_ID,
          name: "Test MG",
          currency: "UGX",
          communities: { id: "comm-1", payment_provider: null },
        });
      // Fallback (e.g. user_roles via currentUserIsSuperAdmin).
      return buildQuery([]);
    },
  }),
}));

vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/lib/auth/access", () => ({
  currentUserIsSuperAdmin: vi.fn().mockResolvedValue(false),
}));

// Stub the BillingTable so we can read the actor map back out of the
// rendered HTML. The stub serializes the prop as JSON inside a hidden
// span — assertions then parse + inspect.
vi.mock("@/components/BillingTable", () => ({
  BillingTable: (props: { actorByLineItemId?: Record<string, string | null> }) =>
    React.createElement(
      "div",
      { "data-testid": "billing-table-stub" },
      React.createElement(
        "span",
        { "data-testid": "actor-map" },
        JSON.stringify(props.actorByLineItemId ?? {})
      )
    ),
}));

vi.mock("@/components/ui/hierarchy-nav", () => ({
  HierarchyNav: () => null,
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// ── Import page (after mocks) ─────────────────────────────────────────────────

import BillingPeriodDetailPage from "../page";

beforeEach(() => {
  LAST_LINE_ITEMS_SELECT = "";
  MOCK_LINE_ITEMS = [
    {
      id: LI_FULL,
      user_directory: {
        first_name: "Alejandro",
        last_name: "Malbet",
        email: "alejandro@example.com",
      },
    },
    {
      id: LI_FIRST_ONLY,
      user_directory: {
        first_name: "Alejandro",
        last_name: null,
        email: "alejandro@example.com",
      },
    },
    {
      id: LI_EMAIL_ONLY,
      user_directory: {
        first_name: null,
        last_name: null,
        email: "alejandro@example.com",
      },
    },
    {
      id: LI_NO_JOIN,
      user_directory: null,
    },
  ];
});

function extractActorMap(html: string): Record<string, string | null> {
  const m = html.match(
    /data-testid="actor-map"[^>]*>([^<]*)<\/span>/
  );
  if (!m) throw new Error("actor-map span not found in rendered HTML");
  // Decode HTML-escaped quotes (renderToStaticMarkup turns " into &quot;).
  const decoded = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
  return JSON.parse(decoded);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("BillingPeriodDetailPage — user_directory actor mapping", () => {
  it("does NOT request the (nonexistent) display_name column", async () => {
    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    renderToStaticMarkup(node as React.ReactElement);
    expect(LAST_LINE_ITEMS_SELECT).not.toContain("display_name");
    expect(LAST_LINE_ITEMS_SELECT).toContain("first_name");
    expect(LAST_LINE_ITEMS_SELECT).toContain("last_name");
    expect(LAST_LINE_ITEMS_SELECT).toContain("email");
  });

  it("composes first_name + last_name with a space when both present", async () => {
    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    const actorMap = extractActorMap(html);
    expect(actorMap[LI_FULL]).toBe("Alejandro Malbet");
  });

  it("uses first_name alone when last_name is null", async () => {
    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    const actorMap = extractActorMap(html);
    expect(actorMap[LI_FIRST_ONLY]).toBe("Alejandro");
  });

  it("falls back to email when both first_name and last_name are null", async () => {
    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    const actorMap = extractActorMap(html);
    expect(actorMap[LI_EMAIL_ONLY]).toBe("alejandro@example.com");
  });

  it("emits null when the user_directory join is null", async () => {
    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    const actorMap = extractActorMap(html);
    expect(actorMap[LI_NO_JOIN]).toBeNull();
  });
});
