// @vitest-environment jsdom
/**
 * CommunitySubNav tests (#119 AC-NAV-*, extended in #204 / PDF2 AC-7).
 *
 * Covers:
 *   - Renders Overview + Payment tabs
 *   - Active-tab derivation via usePathname (longest-prefix match on /payment)
 *   - Payment tab chip renders when paymentHealth prop supplied
 *   - Invoice tab visibility gated by `showInvoiceTab` prop (#204)
 *   - Active-tab derivation includes /invoice when shown (#204)
 *   - ArrowRight cycling covers Invoice tab when shown (#204)
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

let mockPathname = "/communities/comm-abc";
const routerPushMock = vi.fn();
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: routerPushMock }),
}));

import { CommunitySubNav } from "../community-subnav";

describe("CommunitySubNav", () => {
  it("renders Overview + Payment tabs", () => {
    mockPathname = "/communities/comm-abc";
    render(<CommunitySubNav communityId="comm-abc" />);
    expect(screen.getByRole("tab", { name: /overview/i })).toBeDefined();
    expect(screen.getByRole("tab", { name: /payment/i })).toBeDefined();
  });

  it("marks Overview active on /communities/[id]", () => {
    mockPathname = "/communities/comm-abc";
    render(<CommunitySubNav communityId="comm-abc" />);
    const overviewTab = screen.getByRole("tab", { name: /overview/i });
    expect(overviewTab.getAttribute("aria-selected")).toBe("true");
  });

  it("marks Payment active on /communities/[id]/payment", () => {
    mockPathname = "/communities/comm-abc/payment";
    render(<CommunitySubNav communityId="comm-abc" />);
    const paymentTab = screen.getByRole("tab", { name: /payment/i });
    expect(paymentTab.getAttribute("aria-selected")).toBe("true");
  });

  it("renders the payment health chip on the Payment tab when supplied", () => {
    mockPathname = "/communities/comm-abc";
    const { container } = render(
      <CommunitySubNav
        communityId="comm-abc"
        paymentHealth={{
          status: "healthy",
          lastConfiguredAt: "2026-04-23T10:00:00Z",
          relativeTime: "2h ago",
        }}
      />,
    );
    expect(container.textContent).toContain("Healthy");
  });

  it("chip is NOT rendered when paymentHealth is undefined", () => {
    mockPathname = "/communities/comm-abc";
    const { container } = render(<CommunitySubNav communityId="comm-abc" />);
    expect(container.textContent).not.toContain("Healthy");
    expect(container.textContent).not.toContain("Stale");
    expect(container.textContent).not.toContain("Not connected");
  });

  // ── PDF2 (#204) — Invoice tab tests ────────────────────────────────────

  it("(#204) Invoice tab is NOT rendered when showInvoiceTab is omitted (default false)", () => {
    mockPathname = "/communities/comm-abc";
    render(<CommunitySubNav communityId="comm-abc" />);
    expect(screen.queryByRole("tab", { name: /invoice/i })).toBeNull();
  });

  it("(#204) Invoice tab IS rendered when showInvoiceTab=true", () => {
    mockPathname = "/communities/comm-abc";
    render(
      <CommunitySubNav communityId="comm-abc" showInvoiceTab={true} />,
    );
    expect(screen.getByRole("tab", { name: /invoice/i })).toBeDefined();
  });

  it("(#204) Invoice tab is active on /communities/[id]/invoice", () => {
    mockPathname = "/communities/comm-abc/invoice";
    render(
      <CommunitySubNav communityId="comm-abc" showInvoiceTab={true} />,
    );
    const invoiceTab = screen.getByRole("tab", { name: /invoice/i });
    expect(invoiceTab.getAttribute("aria-selected")).toBe("true");
  });

  it("(#204) ArrowRight cycles through 3 tabs when Invoice is shown", () => {
    mockPathname = "/communities/comm-abc";
    routerPushMock.mockClear();
    render(
      <CommunitySubNav communityId="comm-abc" showInvoiceTab={true} />,
    );
    const overview = screen.getByRole("tab", { name: /overview/i });
    overview.focus();

    // Overview → Payment.
    fireEvent.keyDown(overview, { key: "ArrowRight" });
    expect(routerPushMock).toHaveBeenLastCalledWith(
      "/communities/comm-abc/payment",
    );

    // Payment → Invoice.
    const payment = screen.getByRole("tab", { name: /payment/i });
    fireEvent.keyDown(payment, { key: "ArrowRight" });
    expect(routerPushMock).toHaveBeenLastCalledWith(
      "/communities/comm-abc/invoice",
    );

    // Invoice → Overview (cycle).
    const invoice = screen.getByRole("tab", { name: /invoice/i });
    fireEvent.keyDown(invoice, { key: "ArrowRight" });
    expect(routerPushMock).toHaveBeenLastCalledWith("/communities/comm-abc");
  });
});
