// BillingTable BC3 integration tests (jsdom) — covers multi-select,
// switched-to-manual cell extension, and closed-period gating tooltips.
// Complements the existing BillingTable suite in
// src/components/__tests__/billing-table.test.tsx (which covers BC1/BC2).

import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, waitFor, act } from "@testing-library/react";
import { BillingTable } from "@/components/BillingTable";
import { LocaleProvider } from "@/components/format/locale-context";
import type {
  BillingLineItem,
  BillingPeriod,
  Household,
  TierConfig,
} from "@/lib/types/domain";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }),
  }),
}));

Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
  configurable: true,
});

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type: string, init?: PointerEventInit) {
      super(type, init);
    }
  } as typeof PointerEvent;
}

const tiers: TierConfig[] = [
  { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
];

function makePeriod(overrides?: Partial<BillingPeriod>): BillingPeriod {
  return {
    id: "p-1",
    microgrid_id: "mg-1",
    start_date: "2026-04-01",
    end_date: "2026-04-30",
    status: "draft",
    created_at: "2026-04-01T00:00:00Z",
    closed_at: null,
    timezone: "UTC",
    ...overrides,
  };
}

function makeHousehold(id: string, name: string): Household {
  return {
    id,
    microgrid_id: "mg-1",
    display_name: name,
    primary_phone: null,
    primary_email: null,
    address_line1: null,
    address_line2: null,
    unit_label: null,
    address_city: null,
    address_region: null,
    address_country: null,
    address_postal_code: null,
    geography_notes: null,
    created_at: "2026-01-01T00:00:00Z",
  } as unknown as Household;
}

function makeLineItem(
  hid: string,
  overrides?: Partial<BillingLineItem>,
): BillingLineItem {
  return {
    id: `li-${hid}`,
    billing_period_id: "p-1",
    household_id: hid,
    device_id: "d-x", // metered
    usage_kwh: 50,
    start_kwh: 100,
    end_kwh: 150,
    tier_breakdown: [{ label: "Tier 1", kwh: 50, amount: 25000 }],
    total_amount: 25000,
    created_at: "2026-04-01T00:00:00Z",
    payment_status: "unpaid",
    paid_at: null,
    paid_by_user_id: null,
    payment_notes: null,
    pesapal_order_id: null,
    payment_failed_at: null,
    payment_refunded_at: null,
    reading_source: "edge",
    entered_by_user_id: null,
    entered_at: null,
    manual_reason: null,
    ...overrides,
  } as unknown as BillingLineItem;
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

describe("BillingTable BC3 — multi-select", () => {
  it("renders one checkbox per row + a Select all header checkbox", () => {
    const households = [
      makeHousehold("h-1", "Alice"),
      makeHousehold("h-2", "Bob"),
      makeHousehold("h-3", "Carol"),
    ];
    const lineItems = households.map((h) => makeLineItem(h.id));
    render(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod()}
          lineItems={lineItems}
          households={households}
          tiers={tiers}
          currency="UGX"
        />
      </Wrap>,
    );

    const rowCheckboxes = Array.from(
      document.querySelectorAll('input[type="checkbox"]'),
    ).filter((c) =>
      /^Select /.test(c.getAttribute("aria-label") ?? ""),
    );
    // 3 rows + 1 select-all header.
    expect(rowCheckboxes.length).toBe(4);
  });

  it("clicking 2 row checkboxes shows the sticky bar with '2 selected'", () => {
    const households = [
      makeHousehold("h-1", "Alice"),
      makeHousehold("h-2", "Bob"),
      makeHousehold("h-3", "Carol"),
    ];
    const lineItems = households.map((h) => makeLineItem(h.id));
    render(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod()}
          lineItems={lineItems}
          households={households}
          tiers={tiers}
          currency="UGX"
        />
      </Wrap>,
    );

    expect(
      document.querySelector('[data-testid="sticky-selection-bar"]'),
    ).toBeNull();

    const aliceCheckbox = screen.getByLabelText("Select Alice");
    const bobCheckbox = screen.getByLabelText("Select Bob");
    fireEvent.click(aliceCheckbox);
    fireEvent.click(bobCheckbox);

    const bar = document.querySelector(
      '[data-testid="sticky-selection-bar"]',
    );
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain("2 selected");
  });

  it("Select-all header checkbox toggles all rows; second click clears", () => {
    const households = [
      makeHousehold("h-1", "Alice"),
      makeHousehold("h-2", "Bob"),
      makeHousehold("h-3", "Carol"),
    ];
    const lineItems = households.map((h) => makeLineItem(h.id));
    render(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod()}
          lineItems={lineItems}
          households={households}
          tiers={tiers}
          currency="UGX"
        />
      </Wrap>,
    );

    const selectAll = screen.getByLabelText(/Select all 3 rows/i);
    fireEvent.click(selectAll);

    const bar = document.querySelector(
      '[data-testid="sticky-selection-bar"]',
    );
    expect(bar).not.toBeNull();
    expect(bar!.textContent).toContain("3 selected");

    // Second click clears all.
    fireEvent.click(selectAll);
    expect(
      document.querySelector('[data-testid="sticky-selection-bar"]'),
    ).toBeNull();
  });

  it("'Clear selection' button empties the selection set", () => {
    const households = [makeHousehold("h-1", "Alice"), makeHousehold("h-2", "Bob")];
    const lineItems = households.map((h) => makeLineItem(h.id));
    render(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod()}
          lineItems={lineItems}
          households={households}
          tiers={tiers}
          currency="UGX"
        />
      </Wrap>,
    );

    fireEvent.click(screen.getByLabelText("Select Alice"));
    fireEvent.click(screen.getByLabelText("Select Bob"));
    expect(
      document.querySelector('[data-testid="sticky-selection-bar"]'),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Clear selection/i }));
    expect(
      document.querySelector('[data-testid="sticky-selection-bar"]'),
    ).toBeNull();
  });
});

describe("BillingTable BC3 — switched-to-manual cell extension (AC1)", () => {
  it("metered DRAFT cell becomes editable after Switch-to-manual; closed-period stays read-only", async () => {
    const households = [makeHousehold("h-1", "Alice")];
    const lineItems = [makeLineItem("h-1")];

    const { rerender } = render(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod()}
          lineItems={lineItems}
          households={households}
          tiers={tiers}
          currency="UGX"
        />
      </Wrap>,
    );

    // Open the kebab to access "Switch to manual entry…".
    const kebab = screen.getByRole("button", { name: /Row actions for Alice/i });
    fireEvent.pointerDown(kebab, { bubbles: true, cancelable: true });
    fireEvent.click(kebab);

    // Click the "Switch to manual entry…" item.
    await waitFor(() => {
      expect(screen.getByText(/Switch to manual entry/i)).toBeTruthy();
    });
    fireEvent.click(screen.getByText(/Switch to manual entry/i));

    // After: the End (kWh) cell becomes an editable <input>. Look for an
    // input whose aria-label matches the End/Usage cell pattern.
    const inputs = document.querySelectorAll(
      'input[aria-label^="End kWh for line item"]',
    );
    expect(inputs.length).toBeGreaterThanOrEqual(1);

    // Now re-render the same row on a CLOSED period. The kebab item still
    // exists but its onSelect opens the manual dialog (not the cell flip);
    // and the cell stays read-only because isDraft is false.
    rerender(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod({ status: "closed", closed_at: "2026-05-01T00:00:00Z" })}
          lineItems={lineItems}
          households={households}
          tiers={tiers}
          currency="UGX"
        />
      </Wrap>,
    );

    const closedInputs = document.querySelectorAll(
      'input[aria-label^="End kWh for line item"]',
    );
    // No editable inputs on closed period (cell is excluded — see AC1).
    expect(closedInputs.length).toBe(0);
  });
});

describe("BillingTable BC3 — closed-period gating (AC6)", () => {
  it("multi-select bulk button is disabled on closed period with the gating tooltip", () => {
    const households = [makeHousehold("h-1", "Alice")];
    const lineItems = [makeLineItem("h-1")];
    render(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod({ status: "closed", closed_at: "2026-05-01T00:00:00Z" })}
          lineItems={lineItems}
          households={households}
          tiers={tiers}
          currency="UGX"
        />
      </Wrap>,
    );

    fireEvent.click(screen.getByLabelText("Select Alice"));
    const bar = document.querySelector(
      '[data-testid="sticky-selection-bar"]',
    );
    expect(bar).not.toBeNull();
    const regenBtn = bar!.querySelector("button");
    expect(regenBtn?.hasAttribute("disabled")).toBe(true);
    expect(regenBtn?.getAttribute("title")).toContain(
      "Use per-row regenerate on a closed period",
    );
  });

  it("pre-flight panel cannot open on closed period (Generate button is hidden)", () => {
    const households = [makeHousehold("h-1", "Alice")];
    const lineItems = [makeLineItem("h-1")];
    render(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod({ status: "closed", closed_at: "2026-05-01T00:00:00Z" })}
          lineItems={lineItems}
          households={households}
          tiers={tiers}
          currency="UGX"
        />
      </Wrap>,
    );

    // Generate / Refresh Readings buttons are not rendered on closed.
    const headerButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => /^Generate$|^Refresh Readings$/.test(b.textContent?.trim() ?? ""),
    );
    expect(headerButtons.length).toBe(0);

    // No preflight panel is mounted.
    expect(
      document.querySelector('[data-testid="preflight-panel"]'),
    ).toBeNull();
  });
});

describe("BillingTable BC3 — Generate button opens pre-flight panel (AC5)", () => {
  it("clicking Generate (no line items) mounts the pre-flight panel", () => {
    const households = [makeHousehold("h-1", "Alice")];
    render(
      <Wrap>
        <BillingTable
          microgridId="mg-1"
          period={makePeriod()}
          lineItems={[]}
          households={households}
          tiers={tiers}
          currency="UGX"
          edgeAvailableByHouseholdId={{ "h-1": false }}
        />
      </Wrap>,
    );

    expect(
      document.querySelector('[data-testid="preflight-panel"]'),
    ).toBeNull();

    const btn = screen.getByRole("button", { name: /^Generate$/ });
    act(() => {
      fireEvent.click(btn);
    });

    expect(
      document.querySelector('[data-testid="preflight-panel"]'),
    ).not.toBeNull();
  });
});
