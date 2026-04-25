/**
 * audit-humanize.test.tsx — unit tests for humanizeAuditEvent + actorDisplayLabel (BC4 #176).
 *
 * Coverage (per ticket AC9):
 *   - 6 event types each produce the expected label + summary shape.
 *   - 3-state actor naming:
 *       actorUserId === null                          → "System"
 *       actorUserId !== null && actorDisplayName null → "Restricted"
 *       actorDisplayName non-null                     → verbatim
 *   - line_item_generated with missing household_name AND missing
 *     entry.householdName → "Unknown household".
 *   - line_item_regenerated with previous_total_amount === new_total_amount
 *     → "Total unchanged".
 *   - line_item_regenerated with previous_reading_source === null → no
 *     source-change clause.
 *   - line_item_regenerated with both reading sources non-null and
 *     differing → source-change clause appended.
 *   - details.period_was_closed === true → postCloseRevision: true.
 *   - payment_status_changed with from === null → "Set to {to}".
 *   - payment_status_changed with details.notes non-empty → italic-muted
 *     notes line rendered.
 */

// @vitest-environment jsdom

import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import * as React from "react";
import {
  humanizeAuditEvent,
  actorDisplayLabel,
} from "../audit-humanize";
import { LocaleProvider } from "@/components/format/locale-context";
import type { BillingAuditLogEntry } from "@/lib/types/billing-audit";

function entry(
  overrides: Partial<BillingAuditLogEntry> & {
    eventType: BillingAuditLogEntry["eventType"];
  }
): BillingAuditLogEntry {
  return {
    id: "audit:00000000-0000-0000-0000-000000000000",
    actorUserId: null,
    actorDisplayName: null,
    createdAt: "2026-04-25T10:00:00Z",
    billingLineItemId: null,
    householdName: null,
    details: {},
    ...overrides,
  };
}

function renderNode(node: React.ReactNode) {
  // <Currency> needs LocaleProvider; <StatusChip> doesn't but the wrapper
  // doesn't hurt.
  return render(
    <LocaleProvider locale="en-UG" currency="UGX">
      <>{node}</>
    </LocaleProvider>
  );
}

// ── Per-event-type renderers (6) ────────────────────────────────────────────

describe("humanizeAuditEvent — period_created", () => {
  it("renders label 'Period created' with no summary", () => {
    const result = humanizeAuditEvent(entry({ eventType: "period_created" }));
    expect(result.label).toBe("Period created");
    expect(result.summary).toBeUndefined();
    expect(result.postCloseRevision).toBe(false);
  });
});

describe("humanizeAuditEvent — period_closed", () => {
  it("renders label 'Period closed' with no summary", () => {
    const result = humanizeAuditEvent(entry({ eventType: "period_closed" }));
    expect(result.label).toBe("Period closed");
    expect(result.summary).toBeUndefined();
  });
});

describe("humanizeAuditEvent — line_item_generated", () => {
  it("uses entry.householdName + renders 'Total: {amount}' summary", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_generated",
        householdName: "HH-A",
        details: { new_total_amount: 5000 },
      })
    );
    expect(result.label).toBe("Bill generated for HH-A");
    const { container } = renderNode(result.summary);
    // Currency renders the localized form — for UGX it may be "UGX 5,000"
    // or similar; we just check the digits land in the DOM.
    expect(container.textContent ?? "").toContain("5,000");
    expect((container.textContent ?? "").toLowerCase()).toContain("total");
  });

  it("falls back to details.household_name when entry.householdName is null", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_generated",
        householdName: null,
        details: { household_name: "HH-Snapshot", new_total_amount: 1000 },
      })
    );
    expect(result.label).toBe("Bill generated for HH-Snapshot");
  });

  it("falls back to 'Unknown household' when both entry.householdName AND details.household_name missing", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_generated",
        householdName: null,
        details: { new_total_amount: 0 },
      })
    );
    expect(result.label).toBe("Bill generated for Unknown household");
  });
});

describe("humanizeAuditEvent — line_item_regenerated", () => {
  it("renders 'Total changed from X to Y' when amounts differ", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_regenerated",
        householdName: "HH-A",
        details: {
          previous_total_amount: 4000,
          new_total_amount: 5000,
        },
      })
    );
    expect(result.label).toBe("Bill regenerated for HH-A");
    const { container } = renderNode(result.summary);
    expect((container.textContent ?? "").toLowerCase()).toContain("changed from");
    expect(container.textContent ?? "").toContain("4,000");
    expect(container.textContent ?? "").toContain("5,000");
  });

  it("renders 'Total unchanged' when previous_total_amount === new_total_amount", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_regenerated",
        householdName: "HH-A",
        details: {
          previous_total_amount: 5000,
          new_total_amount: 5000,
        },
      })
    );
    const { container } = renderNode(result.summary);
    expect(container.textContent ?? "").toContain("Total unchanged");
  });

  it("renders 'Total unchanged' when previous_total_amount is null (defensive INSERT-path guard)", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_regenerated",
        householdName: "HH-A",
        details: {
          previous_total_amount: null,
          new_total_amount: 5000,
        },
      })
    );
    const { container } = renderNode(result.summary);
    expect(container.textContent ?? "").toContain("Total unchanged");
  });

  it("does NOT append source-change clause when previous_reading_source is null", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_regenerated",
        householdName: "HH-A",
        details: {
          previous_total_amount: null,
          new_total_amount: 5000,
          previous_reading_source: null,
          new_reading_source: "manual",
        },
      })
    );
    const { container } = renderNode(result.summary);
    expect((container.textContent ?? "").toLowerCase()).not.toContain("source changed from");
  });

  it("appends 'Source changed from X to Y' clause when both non-null AND differ", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_regenerated",
        householdName: "HH-A",
        details: {
          previous_total_amount: 4000,
          new_total_amount: 5000,
          previous_reading_source: "edge",
          new_reading_source: "manual",
        },
      })
    );
    const { container } = renderNode(result.summary);
    expect(container.textContent ?? "").toContain("Source changed from");
    expect(container.textContent ?? "").toContain("edge");
    expect(container.textContent ?? "").toContain("manual");
  });

  it("does NOT append source-change clause when previous_reading_source === new_reading_source", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_regenerated",
        householdName: "HH-A",
        details: {
          previous_total_amount: 4000,
          new_total_amount: 5000,
          previous_reading_source: "edge",
          new_reading_source: "edge",
        },
      })
    );
    const { container } = renderNode(result.summary);
    expect((container.textContent ?? "").toLowerCase()).not.toContain("source changed from");
  });
});

describe("humanizeAuditEvent — payment_status_changed", () => {
  it("renders '{from chip} → {to chip}' summary in normal case", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "payment_status_changed",
        householdName: "HH-A",
        details: { from: "unpaid", to: "paid" },
      })
    );
    expect(result.label).toBe("Payment status for HH-A");
    const { container } = renderNode(result.summary);
    // both chip labels present
    expect(container.textContent).toContain("Unpaid");
    expect(container.textContent).toContain("Paid");
    expect(container.textContent).toContain("→");
  });

  it("renders 'Set to {to}' when from === null (initial assignment)", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "payment_status_changed",
        householdName: "HH-A",
        details: { from: null, to: "paid" },
      })
    );
    const { container } = renderNode(result.summary);
    expect(container.textContent).toContain("Set to");
    expect(container.textContent).toContain("Paid");
    // No arrow in the "Set to" branch.
    expect(container.textContent).not.toContain("→");
  });

  it("renders italic-muted notes line when details.notes present", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "payment_status_changed",
        householdName: "HH-A",
        details: { from: "unpaid", to: "paid", notes: "M-Pesa #123" },
      })
    );
    const { container } = renderNode(result.summary);
    expect(container.textContent).toContain("M-Pesa #123");
    // The notes node carries italic + muted classes.
    const noteEl = container.querySelector("span.italic.text-muted-foreground");
    expect(noteEl).not.toBeNull();
  });
});

describe("humanizeAuditEvent — payment_link_generated", () => {
  it("renders label only, no summary", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "payment_link_generated",
        householdName: "HH-A",
      })
    );
    expect(result.label).toBe("Payment link generated for HH-A");
    expect(result.summary).toBeUndefined();
  });
});

// ── Post-close revision flag ─────────────────────────────────────────────────

describe("humanizeAuditEvent — postCloseRevision flag", () => {
  it("returns postCloseRevision: true when details.period_was_closed === true", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_regenerated",
        householdName: "HH-A",
        details: {
          previous_total_amount: 4000,
          new_total_amount: 5000,
          period_was_closed: true,
        },
      })
    );
    expect(result.postCloseRevision).toBe(true);
  });

  it("returns postCloseRevision: false when details.period_was_closed missing", () => {
    const result = humanizeAuditEvent(
      entry({
        eventType: "line_item_generated",
        householdName: "HH-A",
        details: { new_total_amount: 5000 },
      })
    );
    expect(result.postCloseRevision).toBe(false);
  });
});

// ── 3-state actor naming ─────────────────────────────────────────────────────

describe("actorDisplayLabel — 3-state naming", () => {
  it("returns 'System' when actorUserId === null", () => {
    const e = entry({
      eventType: "period_created",
      actorUserId: null,
      actorDisplayName: null,
    });
    expect(actorDisplayLabel(e)).toBe("System");
  });

  it("returns 'System' when actorUserId === null even if a display name leaks through", () => {
    // Defensive: the BC1 fetch helper should never produce this combo, but
    // the rule is "actorUserId === null wins".
    const e = entry({
      eventType: "period_created",
      actorUserId: null,
      actorDisplayName: "ghost",
    });
    expect(actorDisplayLabel(e)).toBe("System");
  });

  it("returns 'Restricted' when actorUserId !== null && actorDisplayName === null", () => {
    const e = entry({
      eventType: "line_item_generated",
      actorUserId: "33333333-3333-4333-8333-333333333333",
      actorDisplayName: null,
    });
    expect(actorDisplayLabel(e)).toBe("Restricted");
  });

  it("returns the verbatim display name when present", () => {
    const e = entry({
      eventType: "line_item_generated",
      actorUserId: "11111111-1111-4111-8111-111111111111",
      actorDisplayName: "Alice Doe",
    });
    expect(actorDisplayLabel(e)).toBe("Alice Doe");
  });
});
