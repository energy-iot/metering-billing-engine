/**
 * billing/[periodId]/page.test.tsx — regression test for the page-level
 * supabase query.
 *
 * Why this exists: an earlier revision asked PostgREST for a non-existent
 * `user_directory.display_name` column, producing a 500 on every billing
 * detail page in production. The previous unit test for this surface
 * (`billing-table.test.tsx`) mocks the `actorByLineItemId` prop directly
 * — so it never exercises the page loader.
 *
 * #269: the user_directory view was replaced by the fn_list_visible_users
 * RPC. The page's single PostgREST FK-join
 * (`user_directory!entered_by_user_id(...)`) was restructured into a
 * two-step fetch: line items first (no join), then a batch
 * `.rpc("fn_list_visible_users", { _target_user_ids: [...] })` keyed by
 * each line item's entered_by_user_id. This test follows that new shape.
 *
 * Strategy:
 *   - Mock @/lib/supabase/server with a per-table dispatcher. The
 *     `billing_line_items` builder returns rows with `entered_by_user_id`
 *     set (no embedded actor data). A separate `rpc` mock returns the
 *     actor rows for the collected ids.
 *   - Mock @/components/BillingTable as a stub that serializes the
 *     `actorByLineItemId` prop into the rendered HTML, so we can
 *     assert what the page computed for each line item.
 *   - Render the page server-side and snapshot the captured map.
 *
 * Coverage (mirrors `pickDisplayName` in src/lib/billing/audit-log-fetch.ts):
 *   1. first_name + last_name → "Alejandro Malbet"
 *   2. first_name only → "Alejandro"
 *   3. email-only fallback (both names null) → "alejandro@example.com"
 *   4. entered_by_user_id IS NULL or RLS-hidden actor → null actor
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

// Stable actor ids per line item — keep distinct so the second-step RPC
// resolves them independently. LI_NO_JOIN has entered_by_user_id = null
// to model the "manual entry by an RLS-hidden actor / no actor recorded"
// branch (the row will not be a key in the actor lookup map).
const ACTOR_FULL = "aaaaaaaa-1111-4111-8111-000000000001";
const ACTOR_FIRST_ONLY = "aaaaaaaa-1111-4111-8111-000000000002";
const ACTOR_EMAIL_ONLY = "aaaaaaaa-1111-4111-8111-000000000003";

// Holders we mutate per-test.
let MOCK_LINE_ITEMS: Array<Record<string, unknown>> = [];
let MOCK_ACTOR_ROWS: Array<Record<string, unknown>> = [];
let LAST_LINE_ITEMS_SELECT = "";
let LAST_RPC_ARGS: Record<string, unknown> | null = null;

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
    // #269: actor resolution moved from a PostgREST FK-join into a
    // second-step RPC. Capture the args (so the test can assert the
    // batch shape) and return the test's MOCK_ACTOR_ROWS.
    rpc: async (name: string, args?: Record<string, unknown>) => {
      if (name === "fn_list_visible_users") {
        LAST_RPC_ARGS = args ?? null;
        return { data: MOCK_ACTOR_ROWS, error: null };
      }
      throw new Error(`Unexpected rpc: ${name}`);
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
  LAST_RPC_ARGS = null;
  MOCK_LINE_ITEMS = [
    { id: LI_FULL, entered_by_user_id: ACTOR_FULL },
    { id: LI_FIRST_ONLY, entered_by_user_id: ACTOR_FIRST_ONLY },
    { id: LI_EMAIL_ONLY, entered_by_user_id: ACTOR_EMAIL_ONLY },
    // RLS-hidden actor / no actor recorded → entered_by_user_id NULL
    // (or absent from the RPC return set even if non-null). Either way,
    // the actor lookup map has no entry → actor is null.
    { id: LI_NO_JOIN, entered_by_user_id: null },
  ];
  MOCK_ACTOR_ROWS = [
    {
      user_id: ACTOR_FULL,
      first_name: "Alejandro",
      last_name: "Malbet",
      email: "alejandro@example.com",
    },
    {
      user_id: ACTOR_FIRST_ONLY,
      first_name: "Alejandro",
      last_name: null,
      email: "alejandro@example.com",
    },
    {
      user_id: ACTOR_EMAIL_ONLY,
      first_name: null,
      last_name: null,
      email: "alejandro@example.com",
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

describe("BillingPeriodDetailPage — fn_list_visible_users actor mapping (#269)", () => {
  it("does NOT request user_directory (dropped) and does NOT embed an actor join", async () => {
    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    renderToStaticMarkup(node as React.ReactElement);
    // Old shape: PostgREST FK-join shorthand on user_directory.
    expect(LAST_LINE_ITEMS_SELECT).not.toContain("user_directory");
    // Old footgun: phantom display_name column on the view.
    expect(LAST_LINE_ITEMS_SELECT).not.toContain("display_name");
    // Caller-shape sanity: the line-items projection still selects payment fields.
    expect(LAST_LINE_ITEMS_SELECT).toContain("payment_status");
  });

  it("batches the actor RPC with the collected entered_by_user_id set", async () => {
    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    renderToStaticMarkup(node as React.ReactElement);
    // LI_NO_JOIN's entered_by_user_id is null → not included in the batch.
    const ids = (LAST_RPC_ARGS?._target_user_ids ?? []) as string[];
    expect(new Set(ids)).toEqual(
      new Set([ACTOR_FULL, ACTOR_FIRST_ONLY, ACTOR_EMAIL_ONLY])
    );
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

  it("emits null when entered_by_user_id is null (no actor to look up)", async () => {
    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    const actorMap = extractActorMap(html);
    expect(actorMap[LI_NO_JOIN]).toBeNull();
  });

  it("emits null when the actor exists but is RLS-hidden (RPC returns no row)", async () => {
    // Replace one of the line items so its actor isn't returned by the RPC,
    // modelling the super_admin-hidden-from-org_manager case.
    const HIDDEN_LI = "990e8400-e29b-41d4-a716-446655444099";
    const HIDDEN_ACTOR = "aaaaaaaa-1111-4111-8111-000000000099";
    MOCK_LINE_ITEMS = [
      { id: HIDDEN_LI, entered_by_user_id: HIDDEN_ACTOR },
    ];
    // MOCK_ACTOR_ROWS does NOT include HIDDEN_ACTOR → RPC simulates RLS hiding.
    MOCK_ACTOR_ROWS = [];

    const node = await BillingPeriodDetailPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    const actorMap = extractActorMap(html);
    expect(actorMap[HIDDEN_LI]).toBeNull();
  });
});
