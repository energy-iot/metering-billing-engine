// Household detail page — server component test (D3 / #54).
//
// Strategy:
//   - Mock @/lib/supabase/server so all three queries return fixture rows.
//   - Call HouseholdDetailPage() directly (async server component) and serialize
//     the returned JSX to HTML.
//   - Cover 4 scenarios: populated, empty devices, empty billing, RLS-404.
//   - Assert chip-highlight assertion for primary_consumption_meter row.
//
// Environment: node (same pattern as D2 page tests).

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// vi.hoisted() runs before vi.mock() hoisting — lets us capture the mock reference.
const { notFoundMock } = vi.hoisted(() => {
  const notFoundMock = vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  return { notFoundMock };
});

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));
vi.mock("next/link", () => ({
  // Render as plain anchor for static markup serialization.
  default: ({
    href,
    children,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    className?: string;
  }) => {
    return React.createElement("a", { href, className }, children);
  },
}));

// ── Auth access mock ──────────────────────────────────────────────────────────
// Stub so currentUserCanAccessMicrogrid doesn't hit Supabase auth.getUser.
vi.mock("@/lib/auth/access", () => ({
  currentUserCanAccessMicrogrid: vi.fn().mockResolvedValue(true),
  currentUserIsSuperAdmin: vi.fn().mockResolvedValue(true),
  currentUserCanAccessCommunity: vi.fn().mockResolvedValue(true),
  currentUserCanAccessOrg: vi.fn().mockResolvedValue(true),
}));

// ── Supabase mock ────────────────────────────────────────────────────────────

const mockFrom = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: mockFrom }),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const HOUSEHOLD_BASE = {
  id: "hh-1",
  display_name: "Block A, Unit 1",
  primary_phone: "+256 772 414 001",
  primary_email: "aisha.m@example.org",
  address_line1: "Plot 14, Kisakye Ln",
  address_line2: "Block A",
  unit_label: "Unit 1",
  status: "active",
};

const DEVICE_ROW = {
  id: "dev-1",
  name: "Chint Meter 01",
  device_type: "consumption_meter",
  edges: { id: "edge-1", name: "Metering Pi" },
};

const BILLING_PERIOD = {
  id: "bp-1",
  start_date: "2026-03-01",
  end_date: "2026-03-31",
  status: "closed",
};

// ── Query builder helpers ─────────────────────────────────────────────────────

/**
 * Builds a mock Supabase query chain for the households table.
 * Supports `.select().eq().eq().single()` pattern.
 */
function buildHouseholdQuery(data: unknown, error: unknown = null) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    single: () => Promise.resolve({ data, error }),
  };
  return chain;
}

/**
 * Builds a mock Supabase query chain for household_users COUNT.
 * Supports `.select("*", { count, head }).eq()` pattern.
 */
function buildCountQuery(count: number) {
  const chain = {
    select: () => chain,
    eq: () => Promise.resolve({ count, error: null }),
  };
  return chain;
}

/**
 * Builds a mock Supabase query chain for billing_line_items.
 * Supports `.select().eq().eq().order().limit().returns()` pattern.
 */
function buildLineItemsQuery(data: unknown) {
  const chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    returns: () => Promise.resolve({ data, error: null }),
  };
  return chain;
}

/**
 * Builds a generic flexible query chain that handles the various query
 * patterns for edges, household_devices, devices (new in #139).
 * Returns { data: [], error: null } for .select().eq() chains and
 * { count: 0, error: null } for count queries.
 */
function buildFlexQuery(data: unknown[] = [], count = 0) {
  const chain: Record<string, unknown> = {};
  const resolve = () => Promise.resolve({ data, count, error: null });
  chain.select = () => chain;
  chain.eq = () => chain;
  chain.in = () => chain;
  chain.not = () => resolve;
  chain.returns = () => Promise.resolve({ data, error: null });
  chain.maybeSingle = () => Promise.resolve({ data: data[0] ?? null, error: null });
  chain.single = () => Promise.resolve({ data: data[0] ?? null, error: null });
  // Make chain itself thenable so await on it works (direct .eq() returns promise)
  (chain as unknown as Promise<unknown>).then = (resolve2: unknown, reject: unknown) =>
    Promise.resolve({ data, count, error: null }).then(resolve2 as never, reject as never);
  return chain;
}

// ── Import page (after mocks) ─────────────────────────────────────────────────

import HouseholdDetailPage from "./page";

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("HouseholdDetailPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // (a) Populated: 1 primary_consumption_meter device + 1 closed billing period
  it("renders all sections for a populated household", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "households") {
        return buildHouseholdQuery({
          ...HOUSEHOLD_BASE,
          household_devices: [
            { role: "primary_consumption_meter", devices: DEVICE_ROW },
          ],
        });
      }
      if (table === "household_users") {
        return buildCountQuery(2);
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([
          {
            usage_kwh: 45.3,
            total_amount: 12500,
            billing_periods: BILLING_PERIOD,
          },
        ]);
      }
      // edges, household_devices, devices queries for P7 hasMetersAvailable
      return buildFlexQuery([]);
    });

    const jsx = await HouseholdDetailPage({
      params: Promise.resolve({ id: "mg-1", householdId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Household basics
    expect(html).toContain("Block A, Unit 1");
    expect(html).toContain("+256 772 414 001");
    expect(html).toContain("aisha.m@example.org");
    expect(html).toContain("Plot 14, Kisakye Ln");
    expect(html).toContain("Block A");
    expect(html).toContain("Unit 1");

    // Portal users
    expect(html).toContain("2 portal users linked");

    // Linked device name + edge link
    expect(html).toContain("Chint Meter 01");
    expect(html).toContain("Metering Pi");
    expect(html).toContain("/microgrids/mg-1/setup/edges/edge-1/");

    // Role chip for primary_consumption_meter — uses warn tone = bg-warning-muted text-warning-fg
    expect(html).toContain("Primary meter");
    // Primary row has bg-warning-muted highlight on the row
    expect(html).toContain("bg-warning-muted");

    // Billing history
    expect(html).toContain("2026-03-01");
    expect(html).toContain("2026-03-31");
  });

  // (b) Empty devices: 0 household_devices → EmptyState with warn tone (#139 P7)
  it("renders EmptyState 'Link this household to its meter' when no devices are linked", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "households") {
        return buildHouseholdQuery({
          ...HOUSEHOLD_BASE,
          household_devices: [],
        });
      }
      if (table === "household_users") {
        return buildCountQuery(0);
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([]);
      }
      // edges, household_devices, devices queries for P7 hasMetersAvailable
      return buildFlexQuery([]);
    });

    const jsx = await HouseholdDetailPage({
      params: Promise.resolve({ id: "mg-1", householdId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("Link this household to its meter");
    expect(html).toContain("primary meter get billed");
    // Billing empty state should still appear (0 line items)
    expect(html).toContain("No billing history");
  });

  // (c) Empty billing: 0 closed billing periods
  it("renders empty billing state when no closed periods exist", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "households") {
        return buildHouseholdQuery({
          ...HOUSEHOLD_BASE,
          household_devices: [
            { role: "primary_consumption_meter", devices: DEVICE_ROW },
          ],
        });
      }
      if (table === "household_users") {
        return buildCountQuery(1);
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([]);
      }
      return buildFlexQuery([]);
    });

    const jsx = await HouseholdDetailPage({
      params: Promise.resolve({ id: "mg-1", householdId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    expect(html).toContain("No billing history");
    // Device section should still render
    expect(html).toContain("Chint Meter 01");
  });

  // (d) RLS-404: non-NFE user gets notFound()
  it("calls notFound() when household query returns an error (RLS deny / not found)", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "households") {
        return buildHouseholdQuery(null, {
          message: "Row not found",
          code: "PGRST116",
        });
      }
      return buildFlexQuery([]);
    });

    await expect(
      HouseholdDetailPage({
        params: Promise.resolve({ id: "mg-1", householdId: "hh-unknown" }),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalledOnce();
  });

  // Chip highlight assertion: primary_consumption_meter row has warn-tone classes
  it("highlights primary_consumption_meter row with warning background", async () => {
    mockFrom.mockImplementation((table: string) => {
      if (table === "households") {
        return buildHouseholdQuery({
          ...HOUSEHOLD_BASE,
          household_devices: [
            { role: "primary_consumption_meter", devices: DEVICE_ROW },
            {
              role: "secondary_meter",
              devices: {
                id: "dev-2",
                name: "Secondary",
                device_type: "consumption_meter",
                edges: { id: "edge-1", name: "Metering Pi" },
              },
            },
          ],
        });
      }
      if (table === "household_users") {
        return buildCountQuery(0);
      }
      if (table === "billing_line_items") {
        return buildLineItemsQuery([]);
      }
      return buildFlexQuery([]);
    });

    const jsx = await HouseholdDetailPage({
      params: Promise.resolve({ id: "mg-1", householdId: "hh-1" }),
    });
    const html = renderToStaticMarkup(jsx as React.ReactElement);

    // Primary row highlighted
    expect(html).toContain("bg-warning-muted");
    // Role chip label for primary
    expect(html).toContain("Primary meter");
    // Role chip label for secondary
    expect(html).toContain("Secondary meter");
  });
});
