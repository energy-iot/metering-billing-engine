// BillingTable integration test (jsdom, component environment)
//
// Strategy:
//   - Mount BillingTable with a minimal fixture (one period, two tiers, three households,
//     three line items) wrapped in <LocaleProvider locale="en-UG" currency="UGX">.
//   - Assert rendered markup only; does NOT fire mutation handlers (Close / Delete /
//     Generate) — those handlers instantiate a Supabase client and router, both mocked.
//   - Assertions:
//     (a) bg-warning-muted in StatusChip for a draft period
//     (b) <caption> text from CopyTable
//     (c) <Currency bareNumber> cells do not contain "UGX"
//     (d) Payment column header present; action button per row
//     (e) Gate banner rendered when isPaymentConfigured=false with role-branched copy
//     (f) Gate banner absent when isPaymentConfigured=true

import { describe, it, expect, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BillingTable } from "../BillingTable";
import { LocaleProvider } from "../format/locale-context";
import type {
  BillingLineItem,
  BillingPeriod,
  Household,
  TierConfig,
} from "@/lib/types/domain";

// Mock next/navigation (BillingTable calls useRouter inside)
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

// Mock Supabase client (BillingTable calls createClient() on render)
// Phase B (#157): also stubs `select().eq()` for the IPN-paid poller
// (which fires every 30s; we never flush the timer in the test, but the
// setup must accept the call shape if it does).
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: () => ({
      delete: () => ({ eq: () => Promise.resolve({ error: null }) }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
    }),
  }),
}));

// Mock clipboard API (CopyButton uses navigator.clipboard)
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
  configurable: true,
});

// Radix Popover uses ResizeObserver in jsdom — stub it.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Radix DropdownMenu also uses PointerEvents in jsdom — stub it for the
// #221 regression-guard test that opens the kebab menu.
if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type: string, init?: PointerEventInit) {
      super(type, init);
    }
  } as typeof PointerEvent;
}

// ─── Fixture data ───────────────────────────────────────────────────────────

const tiers: TierConfig[] = [
  { label: "Tier 1", min_kwh: 1, max_kwh: 50, rate_per_kwh: 500 },
  { label: "Tier 2", min_kwh: 51, max_kwh: null, rate_per_kwh: 800 },
];

const period: BillingPeriod = {
  id: "period-1",
  microgrid_id: "mg-1",
  start_date: "2026-03-01",
  end_date: "2026-03-31",
  status: "draft",
  created_at: "2026-03-01T00:00:00Z",
  closed_at: null,
  timezone: "UTC",
};

const households: Household[] = [
  {
    id: "h-1",
    microgrid_id: "mg-1",
    display_name: "Alice",
    primary_phone: "+256700000000",
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
    // PDF1a (#202) household identity fields.
    account_number: null,
    customer_type: "residential",
    meter_serial: null,
    meter_type: "Smart Submeter",
  },
  {
    id: "h-2",
    microgrid_id: "mg-1",
    display_name: "Bob",
    primary_phone: "+256700000000",
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
    account_number: null,
    customer_type: "residential",
    meter_serial: null,
    meter_type: "Smart Submeter",
  },
  {
    id: "h-3",
    microgrid_id: "mg-1",
    display_name: "Carol",
    primary_phone: "+256700000000",
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
    account_number: null,
    customer_type: "residential",
    meter_serial: null,
    meter_type: "Smart Submeter",
  },
];

const lineItems: BillingLineItem[] = [
  {
    id: "li-1",
    billing_period_id: "period-1",
    household_id: "h-1",
    device_id: "d-1",
    usage_kwh: 80,
    start_kwh: 200,
    end_kwh: 280,
    tier_breakdown: [
      { label: "Tier 1", kwh: 50, amount: 25000 },
      { label: "Tier 2", kwh: 30, amount: 24000 },
    ],
    total_amount: 49000,
    created_at: "2026-04-01T00:00:00Z",
    // payment status columns (migration 00021)
    payment_status: "unpaid",
    paid_at: null,
    paid_by_user_id: null,
    payment_notes: null,
    pesapal_order_id: null,
    payment_failed_at: null,
    payment_refunded_at: null,
    // BC1 (#173) reading-source provenance.
    reading_source: "edge",
    entered_by_user_id: null,
    entered_at: null,
    manual_reason: null,
    // PDF1a (#202) invoice + redirect-url cache.
    invoice_number: null,
    pesapal_redirect_url: null,
    // #223 short-slug indirection (lazy-minted on PDF render).
    short_slug: null,
  },
  {
    id: "li-2",
    billing_period_id: "period-1",
    household_id: "h-2",
    device_id: "d-2",
    usage_kwh: 45,
    start_kwh: 100,
    end_kwh: 145,
    tier_breakdown: [
      { label: "Tier 1", kwh: 45, amount: 22500 },
      { label: "Tier 2", kwh: 0, amount: 0 },
    ],
    total_amount: 22500,
    created_at: "2026-04-01T00:00:00Z",
    payment_status: "unpaid",
    paid_at: null,
    paid_by_user_id: null,
    payment_notes: null,
    pesapal_order_id: null,
    payment_failed_at: null,
    payment_refunded_at: null,
    // BC1 (#173) reading-source provenance.
    reading_source: "edge",
    entered_by_user_id: null,
    entered_at: null,
    manual_reason: null,
    // PDF1a (#202) invoice + redirect-url cache.
    invoice_number: null,
    pesapal_redirect_url: null,
    // #223 short-slug indirection (lazy-minted on PDF render).
    short_slug: null,
  },
  {
    id: "li-3",
    billing_period_id: "period-1",
    household_id: "h-3",
    device_id: "d-3",
    usage_kwh: 110,
    start_kwh: 50,
    end_kwh: 160,
    tier_breakdown: [
      { label: "Tier 1", kwh: 50, amount: 25000 },
      { label: "Tier 2", kwh: 60, amount: 48000 },
    ],
    total_amount: 73000,
    created_at: "2026-04-01T00:00:00Z",
    payment_status: "unpaid",
    paid_at: null,
    paid_by_user_id: null,
    payment_notes: null,
    pesapal_order_id: null,
    payment_failed_at: null,
    payment_refunded_at: null,
    // BC1 (#173) reading-source provenance.
    reading_source: "edge",
    entered_by_user_id: null,
    entered_at: null,
    manual_reason: null,
    // PDF1a (#202) invoice + redirect-url cache.
    invoice_number: null,
    pesapal_redirect_url: null,
    // #223 short-slug indirection (lazy-minted on PDF render).
    short_slug: null,
  },
];

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <LocaleProvider locale="en-UG" currency="UGX">
      {children}
    </LocaleProvider>
  );
}

const baseProps = {
  microgridId: "mg-1",
  period,
  lineItems,
  households,
  tiers,
  currency: "UGX",
};

describe("BillingTable", () => {
  it("(a) draft period status chip contains bg-warning-muted", () => {
    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} />
      </Wrapper>
    );

    // StatusChip for billingPeriod.draft maps to tone="warn" → Chip gets bg-warning-muted class
    const chip = container.querySelector(".bg-warning-muted");
    expect(chip).not.toBeNull();
  });

  it("(b) CopyTable renders a <caption> element with period info", () => {
    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} />
      </Wrapper>
    );

    // CopyTable always renders a <caption> (sr-only) describing the table
    const caption = container.querySelector("caption");
    expect(caption).not.toBeNull();
    // Caption should mention the period
    expect(caption?.textContent).toContain("Billing table for period");
  });

  it("(c) Currency bareNumber cells do not contain 'UGX'", () => {
    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} />
      </Wrapper>
    );

    // CopyTable cells render plain formatted numbers via format functions (no currency symbol)
    // The grand-total footer uses <Currency bareNumber> which also omits "UGX"
    // Find all table data cells and verify none contain the currency code
    const tds = Array.from(container.querySelectorAll("td"));
    const tdTexts = tds.map((td) => td.textContent ?? "");
    const hasUgxInCell = tdTexts.some((t) => t.includes("UGX"));
    expect(hasUgxInCell).toBe(false);
  });

  it("(d) Status column header present; row-actions kebab rendered for each row with line item", () => {
    // BC2 (#174) — Payment column renamed to Status; per-row actions
    // consolidated into a single kebab menu (replaces Payment link button).
    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} isPaymentConfigured={true} />
      </Wrapper>
    );

    // Column header "Status" present (renamed from "Payment").
    const headers = Array.from(container.querySelectorAll("th[scope='col']"));
    const statusHeader = headers.find((h) => h.textContent === "Status");
    expect(statusHeader).not.toBeNull();

    // One row-actions kebab per row with a line item (3 households).
    const kebabs = Array.from(container.querySelectorAll("button")).filter(
      (b) => /row actions for/i.test(b.getAttribute("aria-label") ?? ""),
    );
    expect(kebabs.length).toBe(3);
  });

  it("(e) gate banner rendered for super_admin with go-to-payment link when !isPaymentConfigured", () => {
    const { container } = render(
      <Wrapper>
        <BillingTable
          {...baseProps}
          isPaymentConfigured={false}
          isSuperAdmin={true}
          communityId="comm-1"
        />
      </Wrapper>
    );

    // Gate banner with id="payment-gate-banner" present
    const banner = container.querySelector("#payment-gate-banner");
    expect(banner).not.toBeNull();

    // Contains super_admin copy
    expect(banner?.textContent).toContain("Connect a payment provider");

    // Contains the payment tab link
    const link = container.querySelector(`a[href='/communities/comm-1/payment']`);
    expect(link).not.toBeNull();
  });

  it("(e) gate banner for org_manager shows no link", () => {
    const { container } = render(
      <Wrapper>
        <BillingTable
          {...baseProps}
          isPaymentConfigured={false}
          isSuperAdmin={false}
          communityId="comm-1"
        />
      </Wrapper>
    );

    const banner = container.querySelector("#payment-gate-banner");
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain("Ask a super admin");

    // No payment tab link for org_manager
    const link = container.querySelector(`a[href*='/payment']`);
    expect(link).toBeNull();
  });

  it("(f) gate banner absent when isPaymentConfigured=true", () => {
    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} isPaymentConfigured={true} />
      </Wrapper>
    );

    const banner = container.querySelector("#payment-gate-banner");
    expect(banner).toBeNull();
  });

  it("(#158) un-metered row renders editable END/USAGE inputs; metered rows do not", () => {
    // Mix of metered (h-1, h-2) + un-metered (h-3) to exercise both paths
    // in the same render pass.
    const mixedLineItems: BillingLineItem[] = [
      {
        ...lineItems[0],
      },
      {
        ...lineItems[1],
      },
      {
        ...lineItems[2],
        // un-metered: device_id null, usage_kwh null, end_kwh null
        device_id: null,
        usage_kwh: null,
        end_kwh: null,
        tier_breakdown: [],
        total_amount: 0,
      } as BillingLineItem,
    ];

    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} lineItems={mixedLineItems} />
      </Wrapper>
    );

    // Inline-edit inputs render only for the un-metered row → 2 inputs
    // (end_kwh + usage_kwh). Metered rows render read-only spans.
    const numberInputs = Array.from(
      container.querySelectorAll("input[type='number']")
    );
    expect(numberInputs.length).toBe(2);

    // Each input is associated with the un-metered line item id (li-3).
    const labels = numberInputs.map((i) => i.getAttribute("aria-label"));
    expect(labels.every((l) => l?.includes("li-3"))).toBe(true);
    // One end_kwh + one usage_kwh
    expect(labels.some((l) => l?.startsWith("End kWh"))).toBe(true);
    expect(labels.some((l) => l?.startsWith("Usage kWh"))).toBe(true);
  });

  it("(#158) metered row's END/USAGE cells stay read-only when ALL rows are metered", () => {
    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} />
      </Wrapper>
    );
    const numberInputs = Array.from(
      container.querySelectorAll("input[type='number']")
    );
    expect(numberInputs.length).toBe(0);
  });

  // BC2 (#174) AC3 — entered-by caption (3 cases).
  describe("entered-by caption (BC2 #174 AC3)", () => {
    function makeManualLineItem(
      enteredBy: string | null,
      enteredAt: string | null,
    ): BillingLineItem[] {
      return [
        {
          ...lineItems[0],
          reading_source: "manual",
          entered_by_user_id: enteredBy,
          entered_at: enteredAt,
        },
        lineItems[1],
        lineItems[2],
      ];
    }

    it("manual + actor name → 'Updated by <name> · …' caption renders", () => {
      const { container } = render(
        <Wrapper>
          <BillingTable
            {...baseProps}
            lineItems={makeManualLineItem(
              "user-1",
              new Date(Date.now() - 2 * 60 * 1000).toISOString(),
            )}
            actorByLineItemId={{ "li-1": "Aaron" }}
          />
        </Wrapper>,
      );
      // Paragraph caption present beneath the kebab cell.
      expect(container.textContent).toMatch(/Updated by Aaron/);
    });

    it("manual + actorDisplayName=null (deleted user) → 'Updated by a user · …'", () => {
      const { container } = render(
        <Wrapper>
          <BillingTable
            {...baseProps}
            lineItems={makeManualLineItem(
              "user-deleted",
              new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            )}
            actorByLineItemId={{ "li-1": null }}
          />
        </Wrapper>,
      );
      expect(container.textContent).toMatch(/Updated by a user/);
    });

    it("edge source → no caption rendered", () => {
      const { container } = render(
        <Wrapper>
          <BillingTable
            {...baseProps}
            actorByLineItemId={{ "li-1": "Aaron" }}
          />
        </Wrapper>,
      );
      expect(container.textContent).not.toMatch(/Updated by/);
    });
  });

  // ── BC4 (#176) — "View history" link in period header ─────────────────────

  it("(BC4) renders 'View history' link in the period header on draft periods", () => {
    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} />
      </Wrapper>
    );
    const link = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a")
    ).find((a) => a.textContent?.trim() === "View history");
    expect(link).toBeDefined();
    expect(link!.getAttribute("href")).toBe(
      `/microgrids/mg-1/billing/${period.id}/history`
    );
  });

  it("(BC4) renders 'View history' link in the period header on closed periods", () => {
    const closedPeriod: BillingPeriod = {
      ...period,
      status: "closed",
      closed_at: "2026-04-01T00:00:00Z",
    };
    const { container } = render(
      <Wrapper>
        <BillingTable {...baseProps} period={closedPeriod} />
      </Wrapper>
    );
    const link = Array.from(
      container.querySelectorAll<HTMLAnchorElement>("a")
    ).find((a) => a.textContent?.trim() === "View history");
    expect(link).toBeDefined();
    expect(link!.getAttribute("href")).toBe(
      `/microgrids/mg-1/billing/${closedPeriod.id}/history`
    );
  });

  it("(f) row-actions kebab still renders when !isPaymentConfigured (gate banner explains the why)", () => {
    // BC2 (#174) — payment-link generate items are HIDDEN inside the menu
    // when !isPaymentConfigured, but the kebab itself still renders so the
    // operator can mark-paid / view-history / view-household.
    const { container } = render(
      <Wrapper>
        <BillingTable
          {...baseProps}
          isPaymentConfigured={false}
          isSuperAdmin={true}
          communityId="comm-1"
        />
      </Wrapper>
    );

    const kebabs = Array.from(container.querySelectorAll("button")).filter(
      (b) => /row actions for/i.test(b.getAttribute("aria-label") ?? ""),
    );
    expect(kebabs.length).toBe(3);
  });

  // ── #229: Export CSV button + close-dialog wiring ────────────────────────
  describe("Export CSV (#229)", () => {
    function setupAnchorSpy() {
      // Spy on document.createElement so we can intercept the
      // programmatic <a> the helper builds + clicks.
      const origCreateElement = document.createElement.bind(document);
      const lastAnchor: { href?: string; clicked?: boolean } = {};
      const spy = vi
        .spyOn(document, "createElement")
        .mockImplementation((tagName: string) => {
          const el = origCreateElement(tagName as "a") as HTMLElement;
          if (tagName === "a") {
            const a = el as HTMLAnchorElement;
            const origClick = a.click.bind(a);
            a.click = () => {
              lastAnchor.href = a.href;
              lastAnchor.clicked = true;
              // Don't actually navigate in jsdom.
              try {
                origClick();
              } catch {
                /* jsdom may throw on navigation */
              }
            };
          }
          return el;
        });
      return { lastAnchor, restore: () => spy.mockRestore() };
    }

    it("persistent header button renders on closed AND draft periods", () => {
      const closedPeriod: BillingPeriod = {
        ...period,
        status: "closed",
        closed_at: "2026-04-01T00:00:00Z",
      };
      const { rerender, container } = render(
        <Wrapper>
          <BillingTable {...baseProps} period={closedPeriod} />
        </Wrapper>,
      );
      let btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Export CSV",
      );
      expect(btn).toBeDefined();

      rerender(
        <Wrapper>
          <BillingTable {...baseProps} />
        </Wrapper>,
      );
      btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Export CSV",
      );
      expect(btn).toBeDefined();
    });

    it("clicking the persistent button triggers /api/billing-periods/<id>/export-csv navigation", () => {
      const { lastAnchor, restore } = setupAnchorSpy();
      try {
        const { container } = render(
          <Wrapper>
            <BillingTable {...baseProps} />
          </Wrapper>,
        );
        const btn = Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Export CSV",
        )!;
        expect(btn).toBeDefined();
        fireEvent.click(btn);
        expect(lastAnchor.clicked).toBe(true);
        expect(lastAnchor.href).toContain(
          `/api/billing-periods/${period.id}/export-csv`,
        );
      } finally {
        restore();
      }
    });

    it("disabled with 'Generate readings before exporting' tooltip when lineItems.length === 0 (but households exist)", () => {
      const { container } = render(
        <Wrapper>
          <BillingTable {...baseProps} lineItems={[]} />
        </Wrapper>,
      );
      const btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Export CSV",
      ) as HTMLButtonElement;
      expect(btn).toBeDefined();
      expect(btn.disabled).toBe(true);
      expect(btn.title).toBe("Generate readings before exporting");
    });

    it("disabled with 'No households to export' tooltip when households.length === 0", () => {
      const { container } = render(
        <Wrapper>
          <BillingTable {...baseProps} households={[]} lineItems={[]} />
        </Wrapper>,
      );
      const btn = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Export CSV",
      ) as HTMLButtonElement;
      expect(btn).toBeDefined();
      expect(btn.disabled).toBe(true);
      expect(btn.title).toBe("No households to export");
    });

    it("close-dialog's 'Export CSV for URA' button invokes onExportCsv which triggers /api/.../export-csv navigation", async () => {
      const { lastAnchor, restore } = setupAnchorSpy();
      try {
        // Render the dialog directly with the prop wired the same way
        // BillingTable wires it. Avoids exercising the full close flow.
        const { ClosePeriodDialog } = await import(
          "../ui/close-period-dialog"
        );
        const onExportCsv = vi.fn(() => {
          // Mirror BillingTable's triggerCsvDownload call.
          const a = document.createElement("a");
          a.href = `/api/billing-periods/${period.id}/export-csv`;
          document.body.appendChild(a);
          a.click();
          a.remove();
        });
        render(
          <ClosePeriodDialog
            open
            onOpenChange={() => {}}
            periodLabel="March 2026"
            summaryRows={[]}
            grandTotal={0}
            onConfirm={async () => {}}
            onExportCsv={onExportCsv}
          />,
        );
        // Radix portals into document.body; query against document, not container.
        const queryButtonByText = (text: RegExp) =>
          Array.from(document.querySelectorAll("button")).find((b) =>
            text.test(b.textContent ?? ""),
          );
        // The dialog opens at phase=2; tick the checkbox + click "Close
        // period" to advance to phase=3 where the export CSV button is
        // shown.
        const checkbox = document.querySelector(
          "input[type='checkbox']",
        ) as HTMLInputElement;
        expect(checkbox).toBeTruthy();
        fireEvent.click(checkbox);
        const closeBtn = queryButtonByText(/^Close period$/) as
          | HTMLButtonElement
          | undefined;
        expect(closeBtn).toBeTruthy();
        await act(async () => {
          closeBtn!.click();
        });
        await waitFor(() => {
          expect(queryButtonByText(/^Export CSV for URA$/)).toBeTruthy();
        });
        const exportBtn = queryButtonByText(
          /^Export CSV for URA$/,
        ) as HTMLButtonElement;
        fireEvent.click(exportBtn);
        expect(onExportCsv).toHaveBeenCalledTimes(1);
        expect(lastAnchor.clicked).toBe(true);
        expect(lastAnchor.href).toContain(
          `/api/billing-periods/${period.id}/export-csv`,
        );
      } finally {
        restore();
      }
    });
  });

  // ── #221 regression-guard ────────────────────────────────────────────────
  //
  // BillingTable.tsx:604-609 hand-builds the lineItem prop forwarded to
  // <RowActionsMenu>. If `pesapal_redirect_url` is dropped from that
  // literal, the menu loses its Generate-vs-Regenerate signal silently —
  // the type widening alone wouldn't catch it (Architect evolution-log
  // entry on hand-fabricated `.returns<>` traps). This test renders the
  // full prop chain with a drift-state row and verifies "Regenerate
  // payment link" reaches the dropdown.
  it("(#221) forwards pesapal_redirect_url through the prop chain — drift row shows Regenerate", async () => {
    const driftLineItems: BillingLineItem[] = [
      {
        ...lineItems[0],
        // The drift state from #221: payment_status='unpaid' but a URL
        // is cached on the row.
        payment_status: "unpaid",
        pesapal_redirect_url: "https://pay.example/drift",
      },
      lineItems[1],
      lineItems[2],
    ];

    render(
      <Wrapper>
        <BillingTable
          {...baseProps}
          lineItems={driftLineItems}
          isPaymentConfigured={true}
        />
      </Wrapper>,
    );

    // Open the kebab menu for the drift row (h-1 / Alice).
    const trigger = screen.getByRole("button", {
      name: /row actions for alice/i,
    });
    await act(async () => {
      fireEvent.pointerDown(trigger, { bubbles: true, cancelable: true });
      fireEvent.click(trigger);
    });

    await waitFor(() => screen.getByText(/regenerate payment link/i));
    expect(screen.getByText(/regenerate payment link/i)).toBeTruthy();
    // And explicitly NOT "Generate payment link".
    expect(screen.queryByText(/^generate payment link$/i)).toBeNull();
  });
});

// ── #358 — per-period timezone display ───────────────────────────────────────
//
// The stamped `billing_periods.timezone` (#354) renders as a muted inline
// label beside the period date range. It is a label of record ONLY — the
// HARD guard test below fails if anyone ever feeds it into <LocalDate> as
// a formatting input (that would re-shift the plain-DATE window and
// reintroduce the bug the tz-awareness initiative #353 fixes).
describe("BillingTable — per-period timezone label (#358)", () => {
  function renderWithTimezone(timezone: string) {
    return render(
      <Wrapper>
        <BillingTable {...baseProps} period={{ ...period, timezone }} />
      </Wrapper>
    );
  }

  it("renders the stamped zone as a muted inline label beside the date range", () => {
    const { container } = renderWithTimezone("Africa/Kampala");
    const h2 = container.querySelector("h2");
    // #359 (Designer nit): the zone is joined with a "· " separator, same
    // as the invoice header and the microgrid header.
    expect(h2?.textContent).toContain("· Africa/Kampala (UTC+3)");
    const label = Array.from(h2?.querySelectorAll("span") ?? []).find(
      (el) => el.textContent === "· Africa/Kampala (UTC+3)"
    );
    expect(label).toBeDefined();
    expect(label?.className).toContain("text-muted-foreground");
  });

  it("historical (pre-fix) periods render bare 'UTC'", () => {
    const { container } = renderWithTimezone("UTC");
    const h2 = container.querySelector("h2");
    const label = Array.from(h2?.querySelectorAll("span") ?? []).find(
      (el) => el.className.includes("text-muted-foreground")
    );
    expect(label?.textContent).toBe("· UTC");
  });

  it("HARD guard: window dates render identically under any stamped zone", () => {
    // Pacific/Kiritimati is UTC+14 year-round; if period.timezone were
    // (incorrectly) used to reinterpret the window DATEs, the rendered
    // dates would shift relative to the UTC-stamped render.
    const utc = renderWithTimezone("UTC");
    const utcText = utc.container.querySelector("h2")?.textContent ?? "";
    utc.unmount();
    const kiri = renderWithTimezone("Pacific/Kiritimati");
    const kiriText = kiri.container.querySelector("h2")?.textContent ?? "";
    // Strip each render's own zone label; what remains is the date range.
    const utcDates = utcText.replace("UTC", "").trim();
    const kiriDates = kiriText.replace("Pacific/Kiritimati (UTC+14)", "").trim();
    expect(utcDates.length).toBeGreaterThan(0);
    expect(kiriDates).toBe(utcDates);
  });
});
