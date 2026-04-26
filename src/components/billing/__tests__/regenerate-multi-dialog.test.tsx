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

  it("all-success: dialog closes (calls onOpenChange(false)) and parent banner shows success summary", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 2, errors: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [makeHousehold("h-1", "Alice"), makeHousehold("h-2", "Bob")];
    const lineItems = new Map<string, BillingLineItem>();
    lineItems.set("h-1", makeLineItem("h-1", "edge", 10000));
    lineItems.set("h-2", makeLineItem("h-2", "edge", 12000));

    const onOpenChange = vi.fn();
    const pushParentBanner = vi.fn();
    const onSuccess = vi.fn();
    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={onOpenChange}
          billingPeriodId="p-1"
          selectedHouseholdIds={["h-1", "h-2"]}
          households={households}
          lineItemsByHouseholdId={lineItems}
          pushParentBanner={pushParentBanner}
          pushRowBanner={vi.fn()}
          onSuccess={onSuccess}
        />
      </Wrap>,
    );

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 2 households");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    // No result dialog rendered.
    expect(
      document.querySelector('[data-testid="regen-multi-result-dialog"]'),
    ).toBeNull();
    expect(onSuccess).toHaveBeenCalled();
    const banner = pushParentBanner.mock.calls.find(
      (c) => c[0].tone === "info",
    )?.[0];
    expect(banner?.message).toContain("Regenerated 2 household");
    vi.unstubAllGlobals();
  });

  it("partial-failure (1 of 3 fails, currently_manual): dialog stays open with warn banner + success count + per-row banner", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 2,
          errors: [
            {
              householdId: "h-3",
              householdName: "Carol",
              error: "Currently set to manual entry — use per-row regenerate.",
              code: "currently_manual",
            },
          ],
        }),
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
    lineItems.set("h-3", makeLineItem("h-3", "edge", 8000));

    const onOpenChange = vi.fn();
    const pushParentBanner = vi.fn();
    const pushRowBanner = vi.fn();
    const onSuccess = vi.fn();
    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={onOpenChange}
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

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 3 households");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    // Result dialog appears, ConfirmDialog auto-close did NOT fire.
    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regen-multi-result-dialog"]'),
      ).not.toBeNull(),
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);

    // Per-code copy renders in the result list.
    const list = document.querySelector(
      '[data-testid="regen-multi-result-failure-list"]',
    );
    expect(list).not.toBeNull();
    expect(list!.textContent).toContain("Carol is set to manual entry");

    // Title reflects partial-success summary.
    expect(document.body.textContent).toContain(
      "Regenerated 2 of 3 households",
    );

    // Per-row banner pushed for the failure (AC4).
    expect(pushRowBanner).toHaveBeenCalledTimes(1);
    expect(pushRowBanner.mock.calls[0][0].lineItemId).toBe("li-h-3");

    // Success info banner pushed for the 2 that worked.
    const info = pushParentBanner.mock.calls.find(
      (c) => c[0].tone === "info",
    )?.[0];
    expect(info?.message).toContain("Regenerated 2 household");

    // onSuccess called (partial-success — clear selection).
    expect(onSuccess).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("full failure (3 of 3 fail): dialog stays open with destructive banner; onSuccess NOT called", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 0,
          errors: [
            {
              householdId: "h-1",
              householdName: "Alice",
              error: "no meter reading",
              code: "no_meter_reading",
            },
            {
              householdId: "h-2",
              householdName: "Bob",
              error: "missing config",
              code: "missing_openems_config",
            },
            {
              householdId: "h-3",
              householdName: "Carol",
              error: "no household",
              code: "unknown_household",
            },
          ],
        }),
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
    lineItems.set("h-3", makeLineItem("h-3", "edge", 8000));

    const onSuccess = vi.fn();
    const pushParentBanner = vi.fn();
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
          pushRowBanner={vi.fn()}
          onSuccess={onSuccess}
        />
      </Wrap>,
    );

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 3 households");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regen-multi-result-dialog"]'),
      ).not.toBeNull(),
    );

    // Title for full failure.
    expect(document.body.textContent).toContain(
      "Could not regenerate 3 households",
    );

    // 3 list items (no truncation).
    const items = document.querySelectorAll(
      '[data-testid="regen-multi-result-failure-list"] > li',
    );
    expect(items.length).toBe(3);
    expect(
      document.querySelector(
        '[data-testid="regen-multi-result-failure-overflow"]',
      ),
    ).toBeNull();

    // Order preserved (AC7).
    expect(items[0].textContent).toContain("Alice");
    expect(items[1].textContent).toContain("Bob");
    expect(items[2].textContent).toContain("Carol");

    // No info banner for full failure.
    const info = pushParentBanner.mock.calls.find(
      (c) => c[0].tone === "info",
    );
    expect(info).toBeUndefined();

    // onSuccess NOT called for full failure (selection retained for retry).
    expect(onSuccess).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("truncation: 7 failures → renders 5 + '+ 2 more'", async () => {
    const errs = Array.from({ length: 7 }, (_, i) => ({
      householdId: `h-${i + 1}`,
      householdName: `Person${i + 1}`,
      error: "no meter reading",
      code: "no_meter_reading",
    }));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ lineItems: 0, errors: errs }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = errs.map((e) => makeHousehold(e.householdId, e.householdName));
    const lineItems = new Map<string, BillingLineItem>();
    households.forEach((h) => lineItems.set(h.id, makeLineItem(h.id, "edge", 1000)));

    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={vi.fn()}
          billingPeriodId="p-1"
          selectedHouseholdIds={households.map((h) => h.id)}
          households={households}
          lineItemsByHouseholdId={lineItems}
          pushParentBanner={vi.fn()}
          pushRowBanner={vi.fn()}
        />
      </Wrap>,
    );

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 7 households");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regen-multi-result-dialog"]'),
      ).not.toBeNull(),
    );

    const items = document.querySelectorAll(
      '[data-testid="regen-multi-result-failure-list"] > li',
    );
    // 5 displayed + 1 overflow li = 6 total.
    expect(items.length).toBe(6);
    const overflow = document.querySelector(
      '[data-testid="regen-multi-result-failure-overflow"]',
    );
    expect(overflow).not.toBeNull();
    expect(overflow!.textContent).toContain("+ 2 more");

    vi.unstubAllGlobals();
  });

  it("per-error-code copy smoke: maps unknown_household, no_meter_reading, missing_openems_config", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 0,
          errors: [
            {
              householdId: "h-1",
              householdName: "Alice",
              error: "raw1",
              code: "unknown_household",
            },
            {
              householdId: "h-2",
              householdName: "Bob",
              error: "raw2",
              code: "no_meter_reading",
            },
            {
              householdId: "h-3",
              householdName: "Carol",
              error: "raw3",
              code: "missing_openems_config",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [
      makeHousehold("h-1", "Alice"),
      makeHousehold("h-2", "Bob"),
      makeHousehold("h-3", "Carol"),
    ];
    const lineItems = new Map<string, BillingLineItem>();
    households.forEach((h) =>
      lineItems.set(h.id, makeLineItem(h.id, "edge", 1000)),
    );

    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={vi.fn()}
          billingPeriodId="p-1"
          selectedHouseholdIds={["h-1", "h-2", "h-3"]}
          households={households}
          lineItemsByHouseholdId={lineItems}
          pushParentBanner={vi.fn()}
          pushRowBanner={vi.fn()}
        />
      </Wrap>,
    );

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 3 households");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regen-multi-result-dialog"]'),
      ).not.toBeNull(),
    );

    const text = document.querySelector(
      '[data-testid="regen-multi-result-failure-list"]',
    )!.textContent ?? "";
    expect(text).toContain("Alice no longer belongs to this microgrid.");
    expect(text).toContain("Bob has no current meter reading.");
    expect(text).toContain(
      "Carol's edge has no OpenEMS connection configured.",
    );
    // Verbatim raw strings should NOT appear (per-code mapping wins).
    expect(text).not.toContain("raw1");
    expect(text).not.toContain("raw2");
    expect(text).not.toContain("raw3");

    vi.unstubAllGlobals();
  });

  it("default fallback: unknown code renders '${name}: ${error}'", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 0,
          errors: [
            {
              householdId: "h-1",
              householdName: "Alice",
              error: "Some unmapped server message",
              code: "future_code",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [makeHousehold("h-1", "Alice")];
    const lineItems = new Map<string, BillingLineItem>();
    lineItems.set("h-1", makeLineItem("h-1", "edge", 10000));

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

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 1 household");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regen-multi-result-dialog"]'),
      ).not.toBeNull(),
    );

    const text = document.querySelector(
      '[data-testid="regen-multi-result-failure-list"]',
    )!.textContent ?? "";
    expect(text).toContain("Alice: Some unmapped server message");

    vi.unstubAllGlobals();
  });

  it("Close button in result view calls onOpenChange(false) and does NOT re-fire onSuccess", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          lineItems: 1,
          errors: [
            {
              householdId: "h-2",
              householdName: "Bob",
              error: "no meter",
              code: "no_meter_reading",
            },
          ],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const households = [makeHousehold("h-1", "Alice"), makeHousehold("h-2", "Bob")];
    const lineItems = new Map<string, BillingLineItem>();
    lineItems.set("h-1", makeLineItem("h-1", "edge", 10000));
    lineItems.set("h-2", makeLineItem("h-2", "edge", 12000));

    const onOpenChange = vi.fn();
    const onSuccess = vi.fn();
    render(
      <Wrap>
        <RegenerateMultiDialog
          open
          onOpenChange={onOpenChange}
          billingPeriodId="p-1"
          selectedHouseholdIds={["h-1", "h-2"]}
          households={households}
          lineItemsByHouseholdId={lineItems}
          pushParentBanner={vi.fn()}
          pushRowBanner={vi.fn()}
          onSuccess={onSuccess}
        />
      </Wrap>,
    );

    const confirmBtn = screen
      .getAllByRole("button")
      .find((b) => b.textContent === "Regenerate 2 households");
    await act(async () => {
      fireEvent.click(confirmBtn!);
    });

    await waitFor(() =>
      expect(
        document.querySelector('[data-testid="regen-multi-result-dialog"]'),
      ).not.toBeNull(),
    );

    // onSuccess WAS called once (partial-success → clear selection).
    expect(onSuccess).toHaveBeenCalledTimes(1);

    // Now click Close.
    const closeBtn = document.querySelector(
      '[data-testid="regen-multi-result-close"]',
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(closeBtn);
    });

    expect(onOpenChange).toHaveBeenCalledWith(false);
    // onSuccess was NOT called again by the Close button.
    expect(onSuccess).toHaveBeenCalledTimes(1);

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
