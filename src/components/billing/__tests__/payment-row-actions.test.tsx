// PaymentRowActions — component test (jsdom environment)
//
// Covers:
//   - Both <PaymentLinkButton> and <PaymentStatusControl> render in the action column
//   - Gate-banner wiring: disabled=true when isPaymentConfigured=false
//   - PaymentLinkButton and PaymentStatusControl don't interfere with each other

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PaymentRowActions } from "../payment-row-actions";
import type { PaymentRowActionsProps } from "../payment-row-actions";

// Stub ResizeObserver for Radix components.
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

function makeProps(
  overrides?: Partial<PaymentRowActionsProps>,
): PaymentRowActionsProps {
  return {
    lineItemId: "li-row-1",
    isPaymentConfigured: true,
    lineItem: {
      id: "li-row-1",
      payment_status: "unpaid",
      household_name: "Test Household",
      period_label: "Apr 1 – Apr 30, 2026",
      total_amount: 8000,
      currency: "UGX",
    },
    ...overrides,
  };
}

describe("PaymentRowActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("renders PaymentLinkButton ('Payment link')", () => {
    render(<PaymentRowActions {...makeProps()} />);
    expect(screen.getByRole("button", { name: /payment link/i })).toBeTruthy();
  });

  it("renders PaymentStatusControl chip (payment status button)", () => {
    render(<PaymentRowActions {...makeProps()} />);
    // The StatusChip is inside a span[role=button]
    expect(screen.getByRole("button", { name: /payment status/i })).toBeTruthy();
  });

  it("PaymentLinkButton is disabled when isPaymentConfigured=false", () => {
    render(<PaymentRowActions {...makeProps({ isPaymentConfigured: false })} />);
    const btn = screen.getByRole("button", { name: /payment link/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("PaymentLinkButton has aria-describedby='payment-gate-banner' when disabled", () => {
    render(<PaymentRowActions {...makeProps({ isPaymentConfigured: false })} />);
    const btn = screen.getByRole("button", { name: /payment link/i });
    expect(btn.getAttribute("aria-describedby")).toBe("payment-gate-banner");
  });

  it("PaymentLinkButton is enabled when isPaymentConfigured=true", () => {
    render(<PaymentRowActions {...makeProps({ isPaymentConfigured: true })} />);
    const btn = screen.getByRole("button", { name: /payment link/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders the correct payment status chip label", () => {
    render(
      <PaymentRowActions
        {...makeProps({ lineItem: { ...makeProps().lineItem, payment_status: "paid" } })}
      />,
    );
    // 'Paid' chip should be present
    expect(screen.getByText(/paid/i)).toBeTruthy();
  });

  it("renders both children in the same container (no interference)", () => {
    const { container } = render(<PaymentRowActions {...makeProps()} />);
    const wrapper = container.firstElementChild;
    // Both link button and status control are children
    expect(wrapper?.childElementCount).toBeGreaterThanOrEqual(2);
  });
});
