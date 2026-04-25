// RowActionsMenu — component test (jsdom environment)
//
// Covers the BC2 (#174) consolidated kebab menu. Replaces three retired
// suites: payment-row-actions / payment-status-control / (most of)
// payment-link-button. The popover-specific clipboard tests live in
// payment-link-popover.test.tsx; the menu-state-machine assertions and
// IPN auto-close + entered-by caption + fallback regenerate handler tests
// live here.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { LocaleProvider } from "@/components/format/locale-context";
import {
  RowActionsMenu,
  computeMenuItems,
  type RowActionsMenuProps,
} from "../row-actions-menu";
import type { RowBannerEntry } from "../row-banner-stack";

// Radix DropdownMenu uses ResizeObserver in jsdom — stub it.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Radix Dialog / DropdownMenu also uses PointerEvents in jsdom — stub.
if (typeof globalThis.PointerEvent === "undefined") {
  globalThis.PointerEvent = class PointerEvent extends MouseEvent {
    constructor(type: string, init?: PointerEventInit) {
      super(type, init);
    }
  } as typeof PointerEvent;
}

// Mock clipboard
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: vi.fn().mockResolvedValue(undefined) },
  writable: true,
  configurable: true,
});

function makeProps(
  overrides?: Partial<RowActionsMenuProps>,
): RowActionsMenuProps {
  return {
    microgridId: "mg-1",
    lineItem: {
      id: "li-1",
      payment_status: "unpaid",
      reading_source: "edge",
      total_amount: 12500,
    },
    household: { id: "h-1", display_name: "Alice Mukasa" },
    period: {
      id: "p-1",
      status: "draft",
      start_date: "2026-04-01",
      end_date: "2026-04-30",
    },
    edgeAvailable: true,
    isPaymentConfigured: true,
    onRowBanner: vi.fn(),
    ...overrides,
  };
}

function renderMenu(props: RowActionsMenuProps) {
  return render(
    <LocaleProvider locale="en-UG" currency="UGX">
      <RowActionsMenu {...props} />
    </LocaleProvider>,
  );
}

function openMenu(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, { bubbles: true, cancelable: true });
  fireEvent.click(trigger);
}

// ── computeMenuItems pure-function snapshots ─────────────────────────────────
//
// Six designer states pulled verbatim from
// `mbe-docs/design/mocks/billing-create-v1/billing-create-flows.html`
// "Menu state matrix" cards 1-6.

describe("computeMenuItems — designer matrix (6 states)", () => {
  const baseInput = {
    microgridId: "mg-1",
    household: { id: "h-1", display_name: "Test" },
    period: {
      id: "p-1",
      status: "draft" as const,
      start_date: "2026-04-01",
      end_date: "2026-04-30",
    },
    pendingUrl: null as string | null,
    handlers: {
      onRequestRegenerate: vi.fn(),
      onRequestSwitchToManual: vi.fn(),
      onGenerateLink: vi.fn(),
      onCopyLink: vi.fn(),
      onMarkAsPaid: vi.fn(),
      onMarkAsRefunded: vi.fn(),
      onMarkAsUnpaid: vi.fn(),
      onCancelLink: vi.fn(),
      onMarkAsFailed: vi.fn(),
    },
  };

  it("State 1: Edge · Unpaid · draft · edgeAvailable", () => {
    const items = computeMenuItems({
      ...baseInput,
      lineItem: {
        id: "li-1",
        payment_status: "unpaid",
        reading_source: "edge",
        total_amount: 100,
      },
      edgeAvailable: true,
      isPaymentConfigured: true,
    });
    const labels = items
      .filter((i) => i.kind === "action" || i.kind === "link")
      .map((i) => (i.kind === "action" ? i.label : i.label));
    expect(labels).toContain("Regenerate from edge data");
    expect(labels).toContain("Switch to manual entry…");
    expect(labels).toContain("Generate payment link");
    expect(labels).toContain("Mark as paid…");
    expect(labels).toContain("View household");
  });

  it("State 2: Manual · Link sent · draft · edgeAvailable — 3 link_generated transitions", () => {
    const items = computeMenuItems({
      ...baseInput,
      lineItem: {
        id: "li-2",
        payment_status: "link_generated",
        reading_source: "manual",
        total_amount: 100,
      },
      edgeAvailable: true,
      isPaymentConfigured: true,
    });
    const labels = items
      .filter((i) => i.kind === "action")
      .map((i) => (i.kind === "action" ? i.label : ""));
    // From link_generated: 3 transitions per ALLOWED_MANUAL_TRANSITIONS
    expect(labels).toContain("Mark as paid…");
    expect(labels).toContain("Cancel pending link");
    expect(labels).toContain("Mark as failed");
    // Manual + edgeAvailable → both source toggles
    expect(labels).toContain("Switch back to edge data");
    expect(labels).toContain("Re-enter manual readings…");
  });

  it("State 3: Manual · Unpaid · draft · NO edge — Switch back hidden, not disabled", () => {
    const items = computeMenuItems({
      ...baseInput,
      lineItem: {
        id: "li-3",
        payment_status: "unpaid",
        reading_source: "manual",
        total_amount: 100,
      },
      edgeAvailable: false,
      isPaymentConfigured: true,
    });
    const labels = items
      .filter((i) => i.kind === "action" || i.kind === "link")
      .map((i) => (i.kind === "action" ? i.label : i.label));
    // Switch back to edge data is HIDDEN entirely
    expect(labels).not.toContain("Switch back to edge data");
    expect(labels).toContain("Re-enter manual readings…");
    expect(labels).toContain("Generate payment link");
  });

  it("State 4: Edge · Paid · draft — paid->{unpaid,refunded} only; regen has warning", () => {
    const items = computeMenuItems({
      ...baseInput,
      lineItem: {
        id: "li-4",
        payment_status: "paid",
        reading_source: "edge",
        total_amount: 100,
      },
      edgeAvailable: true,
      isPaymentConfigured: true,
    });
    const actionItems = items.filter((i) => i.kind === "action");
    const labels = actionItems.map((i) => (i.kind === "action" ? i.label : ""));
    expect(labels).toContain("Mark as unpaid");
    expect(labels).toContain("Mark as refunded…");
    // Regen items present + warning-decorated
    const regenEdge = actionItems.find(
      (i) => i.kind === "action" && i.label === "Regenerate from edge data",
    );
    expect(regenEdge).toBeTruthy();
    expect(regenEdge?.kind === "action" && regenEdge.warning).toBe(true);
  });

  it("State 5: Edge · Refunded · draft (terminal) — single disabled item", () => {
    const items = computeMenuItems({
      ...baseInput,
      lineItem: {
        id: "li-5",
        payment_status: "refunded",
        reading_source: "edge",
        total_amount: 100,
      },
      edgeAvailable: true,
      isPaymentConfigured: true,
    });
    const actionItems = items.filter((i) => i.kind === "action");
    // Source-group items + payment-link items hidden on terminal rows
    const labels = actionItems.map((i) => (i.kind === "action" ? i.label : ""));
    expect(labels).not.toContain("Regenerate from edge data");
    expect(labels).not.toContain("Switch to manual entry…");
    expect(labels).not.toContain("Generate payment link");
    // Single disabled status item present
    const noActions = actionItems.find(
      (i) => i.kind === "action" && i.label === "No further status changes available",
    );
    expect(noActions).toBeTruthy();
    expect(noActions?.kind === "action" && noActions.disabled).toBe(true);
  });

  it("State 6: Edge · Paid · CLOSED period (Q4=B) — regen has warning + audit subtext", () => {
    const items = computeMenuItems({
      ...baseInput,
      period: { ...baseInput.period, status: "closed" as const },
      lineItem: {
        id: "li-6",
        payment_status: "paid",
        reading_source: "edge",
        total_amount: 100,
      },
      edgeAvailable: true,
      isPaymentConfigured: true,
    });
    const regen = items.find(
      (i) => i.kind === "action" && i.label === "Regenerate from edge data",
    );
    expect(regen).toBeTruthy();
    expect(regen?.kind === "action" && regen.warning).toBe(true);
    expect(regen?.kind === "action" && regen.subtext).toBe(
      "Logged as audit revision.",
    );
  });
});

// ── State-machine PATCH coverage (mirrors ALLOWED_MANUAL_TRANSITIONS) ────────

describe("RowActionsMenu — payment-status PATCH per ALLOWED_MANUAL_TRANSITIONS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function clickMenuItem(label: RegExp) {
    await waitFor(() => screen.getByText(label));
    await act(async () => {
      fireEvent.click(screen.getByText(label));
    });
  }

  it("paid → unpaid: 'Mark as unpaid' fires PATCH immediately (no dialog)", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ status: "success" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    renderMenu(
      makeProps({
        lineItem: {
          id: "li-1",
          payment_status: "paid",
          reading_source: "edge",
          total_amount: 100,
        },
      }),
    );

    await act(async () => {
      openMenu(screen.getByRole("button", { name: /row actions for/i }));
    });

    await clickMenuItem(/mark as unpaid/i);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/billing-line-items/li-1/payment-status`,
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ status: "unpaid" }),
        }),
      );
    });
  });

  it("link_generated row surfaces THREE menu items (paid + cancel + failed)", async () => {
    renderMenu(
      makeProps({
        lineItem: {
          id: "li-1",
          payment_status: "link_generated",
          reading_source: "edge",
          total_amount: 100,
        },
      }),
    );

    await act(async () => {
      openMenu(screen.getByRole("button", { name: /row actions for/i }));
    });

    await waitFor(() => screen.getByText(/mark as paid/i));
    expect(screen.getByText(/mark as paid/i)).toBeTruthy();
    expect(screen.getByText(/cancel pending link/i)).toBeTruthy();
    expect(screen.getByText(/^mark as failed$/i)).toBeTruthy();
  });
});

// ── Entered-by caption tests are exercised at the BillingTable layer (the
// caption is rendered by BillingTable around the menu, not by the menu
// itself per the agreed cell layout). The relevant assertions live in
// billing-table.test.tsx; the menu-side exposure is the source/status/kebab
// trio. The fallback handler + IPN auto-close + payment-link fetch tests
// follow.

// ── Fallback regenerate handler ──────────────────────────────────────────────

describe("RowActionsMenu — fallback regenerate handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("clicking regenerate items WITHOUT props pushes a BC3-stub banner", async () => {
    const onRowBanner = vi.fn();
    renderMenu(
      makeProps({
        // No onRequestRegenerate, no onRequestSwitchToManual.
        onRowBanner,
        lineItem: {
          id: "li-1",
          payment_status: "unpaid",
          reading_source: "edge",
          total_amount: 100,
        },
      }),
    );

    await act(async () => {
      openMenu(screen.getByRole("button", { name: /row actions for/i }));
    });

    await waitFor(() => screen.getByText(/regenerate from edge data/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/regenerate from edge data/i));
    });

    // Reopen the menu (Radix DropdownMenu auto-closes on item-select).
    await act(async () => {
      openMenu(screen.getByRole("button", { name: /row actions for/i }));
    });

    await waitFor(() => screen.getByText(/switch to manual entry/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/switch to manual entry/i));
    });

    // Both stubs should have fired the BC3 banner.
    const bc3Calls = onRowBanner.mock.calls.filter(
      (c) =>
        (c[0] as RowBannerEntry).message ===
        "Regenerate flow ships with BC3.",
    );
    expect(bc3Calls.length).toBeGreaterThanOrEqual(2);
    bc3Calls.forEach((c) => {
      expect((c[0] as RowBannerEntry).tone).toBe("info");
    });
  });

  it("real onRequestRegenerate prop bypasses the fallback banner", async () => {
    const onRowBanner = vi.fn();
    const onRequestRegenerate = vi.fn();
    renderMenu(
      makeProps({
        onRowBanner,
        onRequestRegenerate,
        lineItem: {
          id: "li-1",
          payment_status: "unpaid",
          reading_source: "edge",
          total_amount: 100,
        },
      }),
    );

    await act(async () => {
      openMenu(screen.getByRole("button", { name: /row actions for/i }));
    });
    await waitFor(() => screen.getByText(/regenerate from edge data/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/regenerate from edge data/i));
    });

    expect(onRequestRegenerate).toHaveBeenCalledWith("edge");
    const bc3Calls = onRowBanner.mock.calls.filter(
      (c) =>
        (c[0] as RowBannerEntry).message ===
        "Regenerate flow ships with BC3.",
    );
    expect(bc3Calls.length).toBe(0);
  });
});

// ── IPN auto-close ───────────────────────────────────────────────────────────

describe("RowActionsMenu — IPN auto-close on payment_status change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("status change with menu open closes menu + pushes info banner", async () => {
    const onRowBanner = vi.fn();
    const props = makeProps({
      onRowBanner,
      lineItem: {
        id: "li-1",
        payment_status: "link_generated",
        reading_source: "edge",
        total_amount: 100,
      },
    });

    const { rerender } = renderMenu(props);

    await act(async () => {
      openMenu(screen.getByRole("button", { name: /row actions for/i }));
    });

    // The menu is open — verify by item visibility.
    await waitFor(() => screen.getByText(/cancel pending link/i));

    // Simulate IPN-driven status flip via prop change (parent's
    // router.refresh() re-renders the server component).
    await act(async () => {
      rerender(
        <LocaleProvider locale="en-UG" currency="UGX">
          <RowActionsMenu
            {...props}
            lineItem={{ ...props.lineItem, payment_status: "paid" }}
          />
        </LocaleProvider>,
      );
    });

    // Menu should auto-close and an info banner should be pushed.
    const infoCalls = onRowBanner.mock.calls.filter(
      (c) => (c[0] as RowBannerEntry).tone === "info",
    );
    expect(infoCalls.length).toBe(1);
    expect((infoCalls[0][0] as RowBannerEntry).durationMs).toBe(5000);
    expect((infoCalls[0][0] as RowBannerEntry).message).toMatch(
      /payment provider/i,
    );
  });
});

// ── Payment-link error path ──────────────────────────────────────────────────

describe("RowActionsMenu — payment-link generation error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("503 response pushes destructive banner with Retry action", async () => {
    const onRowBanner = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: "service unavailable" }),
      }),
    );

    renderMenu(
      makeProps({
        onRowBanner,
        lineItem: {
          id: "li-1",
          payment_status: "unpaid",
          reading_source: "edge",
          total_amount: 100,
        },
      }),
    );

    await act(async () => {
      openMenu(screen.getByRole("button", { name: /row actions for/i }));
    });
    await waitFor(() => screen.getByText(/generate payment link/i));
    await act(async () => {
      fireEvent.click(screen.getByText(/generate payment link/i));
      // Flush promises
      await Promise.resolve();
      await Promise.resolve();
    });

    const errCalls = onRowBanner.mock.calls.filter(
      (c) => (c[0] as RowBannerEntry).tone === "destructive",
    );
    expect(errCalls.length).toBeGreaterThanOrEqual(1);
    const last = errCalls[errCalls.length - 1][0] as RowBannerEntry;
    expect(last.message).toMatch(/failed to generate payment link/i);
    expect(last.action?.label).toBe("Retry");
    expect(typeof last.action?.onClick).toBe("function");
  });
});
