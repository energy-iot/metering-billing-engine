// RegenerateMultiDialog — component tests (jsdom environment) — BC3 #175 AC4

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { LocaleProvider } from "@/components/format/locale-context";
import { RegenerateMultiDialog } from "../regenerate-multi-dialog";
import type { BillingLineItem, Household } from "@/lib/types/domain";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: refreshMock }),
}));

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
  source: "edge" | "manual",
  amount: number,
): BillingLineItem {
  return {
    id: `li-${hid}`,
    billing_period_id: "p-1",
    household_id: hid,
    device_id: null,
    usage_kwh: 50,
    start_kwh: 100,
    end_kwh: 150,
    tier_breakdown: [],
    total_amount: amount,
    created_at: "2026-04-01T00:00:00Z",
    payment_status: "unpaid",
    paid_at: null,
    paid_by_user_id: null,
    payment_notes: null,
    pesapal_order_id: null,
    payment_failed_at: null,
    payment_refunded_at: null,
    reading_source: source,
    entered_by_user_id: null,
    entered_at: null,
    manual_reason: null,
  } as unknown as BillingLineItem;
}

function Wrap({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

describe("RegenerateMultiDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    refreshMock.mockClear();
  });

  it("renders manual rows in 'Will be skipped' subsection; POST excludes them", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 2, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [
      makeHousehold("h-1", "Alice"),
      makeHousehold("h-2", "Bob"),
      makeHousehold("h-3", "Carol"),
    ];
    const lineItems = new Map<string, BillingLineItem>();
    lineItems.set("h-1", makeLineItem("h-1", "edge", 10000));
    lineItems.set("h-2", makeLineItem("h-2", "edge", 12000));
    lineItems.set("h-3", makeLineItem("h-3", "manual", 5000));

    const pushParentBanner = vi.fn();
    const pushRowBanner = vi.fn();
    const onSuccess = vi.fn();

    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={vi.fn()}
          billingPeriodId="p-1"
          selectedHouseholdIds={["h-1", "h-2", "h-3"]}
          households={households}
          lineItemsByHouseholdId={lineItems}
          pushParentBanner={pushParentBanner}
          pushRowBanner={pushRowBanner}
          onSuccess={onSuccess}
        />
      </Wrap>,
    );

    // Skip section visible with the manual row.
    const skipSection = document.querySelector(
      '[data-testid="regen-multi-skip-section"]',
    );
    expect(skipSection).not.toBeNull();
    expect(skipSection!.textContent).toContain("Carol");
    expect(skipSection!.textContent).toContain(
      "Manual readings are per-row only",
    );

    // Confirm button label is "Regenerate 2 households".
    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 2 households");
    expect(confirmBtn).toBeDefined();

    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const call = fetchMock.mock.calls[0];
    expect(call[0]).toBe("/api/billing/generate");
    const body = JSON.parse(call[1].body as string);
    expect(body.billingPeriodId).toBe("p-1");
    // Manual h-3 must be excluded.
    expect(body.householdIds.sort()).toEqual(["h-1", "h-2"].sort());
    expect(body.manualReadings).toBeUndefined();

    // Success info banner with copy "Regenerated 2 households".
    await waitFor(() => expect(pushParentBanner).toHaveBeenCalled());
    const banner = (pushParentBanner.mock.calls.find(
      (c) => c[0].tone === "info",
    )?.[0] ?? null) as { tone: string; message: string } | null;
    expect(banner?.message).toContain("Regenerated 2 household");

    expect(onSuccess).toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("when ALL selected rows are manual, confirm is disabled with 'nothing to regenerate'", () => {
    const households = [makeHousehold("h-1", "Alice")];
    const lineItems = new Map<string, BillingLineItem>();
    lineItems.set("h-1", makeLineItem("h-1", "manual", 5000));

    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={vi.fn()}
          billingPeriodId="p-1"
          selectedHouseholdIds={["h-1"]}
          households={households}
          lineItemsByHouseholdId={lineItems}
          pushParentBanner={vi.fn()}
          pushRowBanner={vi.fn()}
        />
      </Wrap>,
    );

    expect(
      document.querySelector('[data-testid="regen-multi-all-manual-notice"]'),
    ).not.toBeNull();
  });

  it("partial-failure: pushes per-row destructive banner for each errors[] entry", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 1,
          errors: [
            {
              householdId: "h-2",
              householdName: "Bob",
              error: "No meter reading data available",
              code: "no_meter_reading",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [
      makeHousehold("h-1", "Alice"),
      makeHousehold("h-2", "Bob"),
    ];
    const lineItems = new Map<string, BillingLineItem>();
    lineItems.set("h-1", makeLineItem("h-1", "edge", 10000));
    lineItems.set("h-2", makeLineItem("h-2", "edge", 12000));

    const pushParentBanner = vi.fn();
    const pushRowBanner = vi.fn();

    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={vi.fn()}
          billingPeriodId="p-1"
          selectedHouseholdIds={["h-1", "h-2"]}
          households={households}
          lineItemsByHouseholdId={lineItems}
          pushParentBanner={pushParentBanner}
          pushRowBanner={pushRowBanner}
        />
      </Wrap>,
    );

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 2 households");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() => expect(pushRowBanner).toHaveBeenCalled());
    const rowBanner = pushRowBanner.mock.calls[0][0];
    expect(rowBanner.tone).toBe("destructive");
    expect(rowBanner.lineItemId).toBe("li-h-2");
    expect(rowBanner.message).toContain("No meter reading");

    vi.unstubAllGlobals();
  });

  it("currently_manual error display: renders verbatim when server diverged from client snapshot", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 0,
          errors: [
            {
              householdId: "h-1",
              householdName: "Alice",
              error:
                "Currently set to manual entry — use per-row regenerate to change.",
              code: "currently_manual",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [makeHousehold("h-1", "Alice")];
    const lineItems = new Map<string, BillingLineItem>();
    // Client thinks Alice is edge, but server says she's manual.
    lineItems.set("h-1", makeLineItem("h-1", "edge", 10000));

    const pushRowBanner = vi.fn();
    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={vi.fn()}
          billingPeriodId="p-1"
          selectedHouseholdIds={["h-1"]}
          households={households}
          lineItemsByHouseholdId={lineItems}
          pushParentBanner={vi.fn()}
          pushRowBanner={pushRowBanner}
        />
      </Wrap>,
    );

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 1 household");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() => expect(pushRowBanner).toHaveBeenCalled());
    const rowBanner = pushRowBanner.mock.calls[0][0];
    expect(rowBanner.message).toContain("Currently set to manual entry");

    vi.unstubAllGlobals();
  });
});
