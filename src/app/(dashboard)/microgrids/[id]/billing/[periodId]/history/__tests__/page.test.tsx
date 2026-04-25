/**
 * history/page.test.tsx — BC4 #176 server-component integration test.
 *
 * Mocks @/lib/supabase/server and @/lib/billing/audit-log-fetch so we
 * can exercise the page's render branches without a live DB:
 *
 *   - Happy path: the page returns markup containing the audit list.
 *   - With searchParams.household_id set: filter narrows the visible
 *     entries; the "Show all" link clears the param.
 *   - Empty period (zero entries) → "No changes recorded yet"; <ol>
 *     is NOT rendered.
 *
 * Strategy: import the page module then call the default export directly
 * (it's an async server component). Render the returned JSX with
 * react-dom/server's renderToStaticMarkup. This mirrors the pattern in
 * src/app/(dashboard)/microgrids/[id]/__tests__/page.test.tsx.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import React from "react";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";

const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";
const MICROGRID_ID = "770e8400-e29b-41d4-a716-446655442000";
const HH_A = "880e8400-e29b-41d4-a716-446655443001";
const HH_B = "880e8400-e29b-41d4-a716-446655443002";
const LI_A = "990e8400-e29b-41d4-a716-446655444001";
const LI_B = "990e8400-e29b-41d4-a716-446655444002";

// ── Mocks ─────────────────────────────────────────────────────────────────────

// Holders we mutate per-test.
let MOCK_PERIOD: { id: string; microgrid_id: string } | null = {
  id: PERIOD_ID,
  microgrid_id: MICROGRID_ID,
};
let MOCK_HOUSEHOLDS: { id: string; display_name: string }[] = [
  { id: HH_A, display_name: "HH-A" },
  { id: HH_B, display_name: "HH-B" },
];
let MOCK_LINE_ITEMS: { id: string; household_id: string }[] = [
  { id: LI_A, household_id: HH_A },
  { id: LI_B, household_id: HH_B },
];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      if (table === "billing_periods") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                single: () =>
                  Promise.resolve({
                    data: MOCK_PERIOD,
                    error: MOCK_PERIOD ? null : { message: "not found" },
                  }),
              }),
            }),
          }),
        };
      }
      if (table === "households") {
        return {
          select: () => ({
            eq: () => ({
              returns: () =>
                Promise.resolve({ data: MOCK_HOUSEHOLDS, error: null }),
            }),
          }),
        };
      }
      if (table === "billing_line_items") {
        return {
          select: () => ({
            in: () =>
              Promise.resolve({ data: MOCK_LINE_ITEMS, error: null }),
          }),
        };
      }
      throw new Error(`Unexpected table in history page test: ${table}`);
    },
  }),
}));

vi.mock("@/lib/hierarchy", () => ({
  getHierarchyLevels: vi.fn().mockResolvedValue([]),
}));

let MOCK_AUDIT_RESULT: {
  kind: "ok" | "unauthorized" | "not_found" | "error";
  entries?: BillingAuditLogEntry[];
  message?: string;
} = { kind: "ok", entries: [] };

vi.mock("@/lib/billing/audit-log-fetch", () => ({
  fetchAuditLogEntries: vi.fn(async () => MOCK_AUDIT_RESULT),
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

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

import HistoryPage from "../page";

const FIVE_ENTRIES: BillingAuditLogEntry[] = [
  {
    id: "audit:1",
    eventType: "period_created",
    actorUserId: "11111111-1111-4111-8111-111111111111",
    actorDisplayName: "Alice Doe",
    createdAt: "2026-04-25T10:00:00Z",
    billingLineItemId: null,
    householdName: null,
    details: {},
  },
  {
    id: "audit:2",
    eventType: "line_item_generated",
    actorUserId: "11111111-1111-4111-8111-111111111111",
    actorDisplayName: "Alice Doe",
    createdAt: "2026-04-25T11:00:00Z",
    billingLineItemId: LI_A,
    householdName: "HH-A",
    details: { household_name: "HH-A", new_total_amount: 5000 },
  },
  {
    id: "audit:3",
    eventType: "line_item_regenerated",
    actorUserId: null,
    actorDisplayName: null,
    createdAt: "2026-04-25T12:00:00Z",
    billingLineItemId: LI_B,
    householdName: "HH-B",
    details: {
      household_name: "HH-B",
      previous_total_amount: 3000,
      new_total_amount: 4000,
      previous_reading_source: "edge",
      new_reading_source: "manual",
    },
  },
  {
    id: "payment_event:4",
    eventType: "payment_status_changed",
    actorUserId: "11111111-1111-4111-8111-111111111111",
    actorDisplayName: "Alice Doe",
    createdAt: "2026-04-25T13:00:00Z",
    billingLineItemId: LI_A,
    householdName: "HH-A",
    details: { from: "unpaid", to: "paid", source: "manual" },
  },
  {
    id: "payment_event:5",
    eventType: "payment_link_generated",
    actorUserId: null,
    actorDisplayName: null,
    createdAt: "2026-04-25T14:00:00Z",
    billingLineItemId: LI_B,
    householdName: "HH-B",
    details: { from: "unpaid", to: "link_generated", source: "generate_link" },
  },
];

beforeEach(() => {
  MOCK_PERIOD = { id: PERIOD_ID, microgrid_id: MICROGRID_ID };
  MOCK_HOUSEHOLDS = [
    { id: HH_A, display_name: "HH-A" },
    { id: HH_B, display_name: "HH-B" },
  ];
  MOCK_LINE_ITEMS = [
    { id: LI_A, household_id: HH_A },
    { id: LI_B, household_id: HH_B },
  ];
  MOCK_AUDIT_RESULT = { kind: "ok", entries: [] };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("HistoryPage — happy path", () => {
  it("renders one <li> per entry under <ol aria-label='Audit history'>", async () => {
    MOCK_AUDIT_RESULT = { kind: "ok", entries: FIVE_ENTRIES };
    const node = await HistoryPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    expect(html).toContain('aria-label="Audit history"');
    // 5 entries → 5 li's. Use a regex that counts opening li tags.
    const liCount = (html.match(/<li\b/g) ?? []).length;
    expect(liCount).toBe(5);
    expect(html).toContain("Bill generated for HH-A");
    expect(html).toContain("Bill regenerated for HH-B");
    expect(html).toContain("Payment status for HH-A");
    expect(html).toContain("Payment link generated for HH-B");
    expect(html).toContain("Period created");
  });
});

describe("HistoryPage — household_id filter", () => {
  it("only renders entries belonging to the filtered household + Show all link clears the param", async () => {
    MOCK_AUDIT_RESULT = { kind: "ok", entries: FIVE_ENTRIES };
    const node = await HistoryPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
      searchParams: Promise.resolve({ household_id: HH_A }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    // 2 entries belong to LI_A → HH_A.
    const liCount = (html.match(/<li\b/g) ?? []).length;
    expect(liCount).toBe(2);
    expect(html).toContain("Bill generated for HH-A");
    expect(html).toContain("Payment status for HH-A");
    expect(html).not.toContain("Bill regenerated for HH-B");
    expect(html).not.toContain("Payment link generated for HH-B");
    // Show all link clears the param.
    expect(html).toContain(
      `href="/microgrids/${MICROGRID_ID}/billing/${PERIOD_ID}/history"`
    );
  });
});

describe("HistoryPage — empty states", () => {
  it("renders 'No changes recorded yet' when zero entries (no filter), and omits the <ol>", async () => {
    MOCK_AUDIT_RESULT = { kind: "ok", entries: [] };
    const node = await HistoryPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
      searchParams: Promise.resolve({}),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    expect(html).toContain("No changes recorded yet");
    expect(html).not.toContain('aria-label="Audit history"');
  });

  it("renders 'No changes recorded for HH-A' when filter narrows to zero, and omits the <ol>", async () => {
    // entries exist but none for HH_A (LI_A absent from line-items map).
    MOCK_AUDIT_RESULT = {
      kind: "ok",
      entries: [
        {
          id: "audit:other",
          eventType: "line_item_generated",
          actorUserId: null,
          actorDisplayName: null,
          createdAt: "2026-04-25T10:00:00Z",
          billingLineItemId: LI_B,
          householdName: "HH-B",
          details: { household_name: "HH-B", new_total_amount: 100 },
        },
      ],
    };
    const node = await HistoryPage({
      params: Promise.resolve({ id: MICROGRID_ID, periodId: PERIOD_ID }),
      searchParams: Promise.resolve({ household_id: HH_A }),
    });
    const html = renderToStaticMarkup(node as React.ReactElement);
    expect(html).toContain("No changes recorded for HH-A");
    expect(html).not.toContain('aria-label="Audit history"');
  });
});
