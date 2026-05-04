/**
 * audit-log-list.test.tsx — BC4 #176 list/empty-state/filter/truncation tests.
 *
 * Coverage (per ticket AC9):
 *   - Renders one <li> per entry under <ol aria-label="Audit history">.
 *   - Each event type from AC4 produces the expected label + summary.
 *   - Filter by household_id: only matching entries render; <ol> contains
 *     just those rows; "Show all" link clears the param.
 *   - Empty state #1 (no entries for period): "No changes recorded yet"
 *     copy; <ol> NOT rendered.
 *   - Empty state #2 (no entries after filter): "No changes recorded for X"
 *     copy + Show all secondary link; <ol> NOT rendered.
 *   - Truncation notice when entries.length >= 1000.
 */

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LocaleProvider } from "@/components/format/locale-context";
import { AuditLogList } from "../audit-log-list";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

const PERIOD_ID = "660e8400-e29b-41d4-a716-446655441000";
const MICROGRID_ID = "770e8400-e29b-41d4-a716-446655442000";
const HH_A = "880e8400-e29b-41d4-a716-446655443001";
const HH_B = "880e8400-e29b-41d4-a716-446655443002";
const LI_A = "990e8400-e29b-41d4-a716-446655444001";
const LI_B = "990e8400-e29b-41d4-a716-446655444002";

const ENTRIES: BillingAuditLogEntry[] = [
  {
    id: "audit:00000000-0000-0000-0000-000000000001",
    eventType: "period_created",
    actorUserId: "11111111-1111-4111-8111-111111111111",
    actorDisplayName: "Alice Doe",
    createdAt: "2026-04-25T10:00:00Z",
    billingLineItemId: null,
    householdName: null,
    details: {},
  },
  {
    id: "audit:00000000-0000-0000-0000-000000000002",
    eventType: "line_item_generated",
    actorUserId: "11111111-1111-4111-8111-111111111111",
    actorDisplayName: "Alice Doe",
    createdAt: "2026-04-25T11:00:00Z",
    billingLineItemId: LI_A,
    householdName: "HH-A",
    details: { household_name: "HH-A", new_total_amount: 5000 },
  },
  {
    id: "audit:00000000-0000-0000-0000-000000000003",
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
      manual_reason: "Operator estimate",
      period_was_closed: true,
      // #218: previous_snapshot is additive JSONB on regenerate events. The
      // humanizer reads only specific top-level keys via
      // `entry.details?.["…"]` and never iterates `Object.keys(details)`,
      // so this field is silently ignored by the existing renderers (as
      // intended — display is OOS for #218; this fixture guards against
      // future "improve the humanizer" regressions accidentally surfacing
      // the snapshot or swapping its `manual_reason` with the top-level
      // NEW reason).
      previous_snapshot: {
        start_kwh: 100,
        end_kwh: 350,
        usage_kwh: 250,
        tier_breakdown: [{ label: "T1", kwh: 250, amount: 12500 }],
        device_id: null,
        entered_by_user_id: "11111111-1111-4111-8111-111111111111",
        entered_at: "2026-04-20T10:00:00Z",
        manual_reason: "initial estimate",
      },
    },
  },
  {
    id: "payment_event:00000000-0000-0000-0000-000000000004",
    eventType: "payment_status_changed",
    actorUserId: "11111111-1111-4111-8111-111111111111",
    actorDisplayName: "Alice Doe",
    createdAt: "2026-04-25T13:00:00Z",
    billingLineItemId: LI_A,
    householdName: "HH-A",
    details: { from: "unpaid", to: "paid", source: "manual" },
  },
  {
    id: "payment_event:00000000-0000-0000-0000-000000000005",
    eventType: "payment_link_generated",
    actorUserId: null,
    actorDisplayName: null,
    createdAt: "2026-04-25T14:00:00Z",
    billingLineItemId: LI_B,
    householdName: "HH-B",
    details: { from: "unpaid", to: "link_generated", source: "generate_link" },
  },
];

const LINE_ITEM_TO_HH: Record<string, string> = {
  [LI_A]: HH_A,
  [LI_B]: HH_B,
};
const HH_NAMES: Record<string, string> = {
  [HH_A]: "HH-A",
  [HH_B]: "HH-B",
};

describe("<AuditLogList> — list rendering", () => {
  it("renders <ol aria-label='Audit history'> with one <li> per entry", () => {
    const { container } = render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={HH_NAMES}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );

    const ol = container.querySelector("ol[aria-label='Audit history']");
    expect(ol).not.toBeNull();
    const lis = ol!.querySelectorAll("li");
    expect(lis.length).toBe(ENTRIES.length);
  });

  it("renders the 6 event-type labels and summaries", () => {
    render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={HH_NAMES}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );

    expect(screen.getByText("Period created")).toBeTruthy();
    expect(screen.getByText("Bill generated for HH-A")).toBeTruthy();
    expect(screen.getByText("Bill regenerated for HH-B")).toBeTruthy();
    expect(screen.getByText("Payment status for HH-A")).toBeTruthy();
    expect(screen.getByText("Payment link generated for HH-B")).toBeTruthy();
  });

  it("renders 'post-close revision' chip when details.period_was_closed === true", () => {
    render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={HH_NAMES}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    // Chip text is uppercased via Tailwind `uppercase` class — DOM text
    // content is the original source ("post-close revision").
    expect(screen.getByText("post-close revision")).toBeTruthy();
  });

  it("renders manual_reason as italic muted text", () => {
    const { container } = render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={HH_NAMES}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    const reasonEl = Array.from(
      container.querySelectorAll(".italic.text-muted-foreground")
    ).find((el) => el.textContent?.includes("Operator estimate"));
    expect(reasonEl).toBeDefined();
    // #218 naming-clash guard: `previous_snapshot.manual_reason` is the
    // PREVIOUS reason, distinct from the top-level (NEW) `manual_reason`.
    // The humanizer reads only top-level keys; it must not surface the
    // snapshot's `manual_reason` as raw display, and a future PR must not
    // silently swap the two semantically-distinct keys.
    expect(screen.queryByText("initial estimate")).toBeNull();
  });

  it("renders 3-state actor names (System / Restricted / verbatim)", () => {
    render(
      <Wrapper>
        <AuditLogList
          entries={[
            {
              id: "audit:1",
              eventType: "period_created",
              actorUserId: null,
              actorDisplayName: null,
              createdAt: "2026-04-25T10:00:00Z",
              billingLineItemId: null,
              householdName: null,
              details: {},
            },
            {
              id: "audit:2",
              eventType: "period_closed",
              actorUserId: "33333333-3333-4333-8333-333333333333",
              actorDisplayName: null,
              createdAt: "2026-04-25T11:00:00Z",
              billingLineItemId: null,
              householdName: null,
              details: {},
            },
            {
              id: "audit:3",
              eventType: "period_created",
              actorUserId: "11111111-1111-4111-8111-111111111111",
              actorDisplayName: "Alice Doe",
              createdAt: "2026-04-25T12:00:00Z",
              billingLineItemId: null,
              householdName: null,
              details: {},
            },
          ]}
          lineItemIdToHouseholdId={{}}
          householdNamesById={{}}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    expect(screen.getByText("System")).toBeTruthy();
    expect(screen.getByText("Restricted")).toBeTruthy();
    expect(screen.getByText("Alice Doe")).toBeTruthy();
  });
});

// ── Filter by household_id ───────────────────────────────────────────────────

describe("<AuditLogList> — household_id filter", () => {
  it("only renders entries whose billingLineItemId belongs to the filtered household", () => {
    const { container } = render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={HH_NAMES}
          filterHouseholdId={HH_A}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    const ol = container.querySelector("ol[aria-label='Audit history']");
    expect(ol).not.toBeNull();
    const lis = ol!.querySelectorAll("li");
    // Only entries whose billingLineItemId === LI_A → "Bill generated for
    // HH-A" + "Payment status for HH-A" = 2.
    expect(lis.length).toBe(2);
    expect(screen.getByText("Bill generated for HH-A")).toBeTruthy();
    expect(screen.getByText("Payment status for HH-A")).toBeTruthy();
    expect(screen.queryByText("Bill regenerated for HH-B")).toBeNull();
    expect(screen.queryByText("Payment link generated for HH-B")).toBeNull();
    // period_created has no billingLineItemId → filtered out.
    expect(screen.queryByText("Period created")).toBeNull();
  });

  it("renders the filter banner with a 'Show all' link that clears the query param", () => {
    const { container } = render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={HH_NAMES}
          filterHouseholdId={HH_A}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    const showAllLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a")
    ).filter((a) => a.textContent?.trim() === "Show all");
    expect(showAllLinks.length).toBeGreaterThan(0);
    expect(showAllLinks[0].getAttribute("href")).toBe(
      `/microgrids/${MICROGRID_ID}/billing/${PERIOD_ID}/history`
    );
  });

  it("when household_id is unknown, renders 'unknown household' in the banner", () => {
    render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={HH_NAMES}
          filterHouseholdId="ffffffff-ffff-4fff-8fff-ffffffffffff"
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    // The unknown filter id matches no entries → empty-state #2 ("No
    // changes recorded for unknown household").
    expect(screen.getByText("No changes recorded for unknown household")).toBeTruthy();
  });
});

// ── Empty states ─────────────────────────────────────────────────────────────

describe("<AuditLogList> — empty states", () => {
  it("renders 'No changes recorded yet' when entries is empty AND no filter", () => {
    const { container } = render(
      <Wrapper>
        <AuditLogList
          entries={[]}
          lineItemIdToHouseholdId={{}}
          householdNamesById={{}}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    expect(screen.getByText("No changes recorded yet")).toBeTruthy();
    expect(
      screen.getByText(/This period has no events/i)
    ).toBeTruthy();
    // <ol> NOT rendered when there are zero entries.
    expect(container.querySelector("ol[aria-label='Audit history']")).toBeNull();
  });

  it("renders 'No changes recorded for {hh}' + Show all secondary when filter narrows to zero", () => {
    const { container } = render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={{ ...HH_NAMES, "no-entries-for-this-id": "HH-NoOne" }}
          filterHouseholdId="no-entries-for-this-id"
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    expect(screen.getByText("No changes recorded for HH-NoOne")).toBeTruthy();
    expect(
      screen.getByText(/Other households on this period may have entries/i)
    ).toBeTruthy();
    // Secondary link to clear the filter.
    const showAllLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a")
    ).filter((a) => a.textContent?.trim() === "Show all");
    expect(showAllLinks.length).toBeGreaterThan(0);
    expect(showAllLinks[0].getAttribute("href")).toBe(
      `/microgrids/${MICROGRID_ID}/billing/${PERIOD_ID}/history`
    );
    // <ol> NOT rendered when filter narrows to zero either.
    expect(container.querySelector("ol[aria-label='Audit history']")).toBeNull();
  });
});

// ── Truncation notice ────────────────────────────────────────────────────────

describe("<AuditLogList> — truncation notice", () => {
  it("renders 'History may be truncated' when entries.length >= 1000", () => {
    const big: BillingAuditLogEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      big.push({
        id: `audit:${i}`,
        eventType: "period_created",
        actorUserId: null,
        actorDisplayName: null,
        createdAt: `2026-04-25T${String(i % 24).padStart(2, "0")}:00:00Z`,
        billingLineItemId: null,
        householdName: null,
        details: {},
      });
    }
    render(
      <Wrapper>
        <AuditLogList
          entries={big}
          lineItemIdToHouseholdId={{}}
          householdNamesById={{}}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    expect(screen.getByText("History may be truncated")).toBeTruthy();
  });

  it("does NOT render the truncation notice when entries.length < 1000", () => {
    render(
      <Wrapper>
        <AuditLogList
          entries={ENTRIES}
          lineItemIdToHouseholdId={LINE_ITEM_TO_HH}
          householdNamesById={HH_NAMES}
          microgridId={MICROGRID_ID}
          periodId={PERIOD_ID}
        />
      </Wrapper>
    );
    expect(screen.queryByText("History may be truncated")).toBeNull();
  });
});
