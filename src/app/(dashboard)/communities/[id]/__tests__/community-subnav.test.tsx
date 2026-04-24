// @vitest-environment jsdom
/**
 * CommunitySubNav tests (#119 AC-NAV-*).
 *
 * Covers:
 *   - Renders Overview + Payment tabs
 *   - Active-tab derivation via usePathname (longest-prefix match on /payment)
 *   - Payment tab chip renders when paymentHealth prop supplied
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let mockPathname = "/communities/comm-abc";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({ push: vi.fn() }),
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
});
